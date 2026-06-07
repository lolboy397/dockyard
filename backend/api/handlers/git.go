package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

const reposRoot = "/data/repos"

// GitHandlers handles all git source-control API requests.
type GitHandlers struct {
	db *storage.DB
}

// NewGitHandlers creates a new GitHandlers.
func NewGitHandlers(db *storage.DB) *GitHandlers {
	return &GitHandlers{db: db}
}

// ── Response types ───────────────────────────────────────────────────────────

// GitRepoSummary is returned by List with live computed fields.
type GitRepoSummary struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	RemoteURL   string     `json:"remote_url"`
	AuthorName  string     `json:"author_name"`
	AuthorEmail string     `json:"author_email"`
	Description string     `json:"description"`
	Branch      string     `json:"branch"`
	AheadBy     int        `json:"ahead_by"`
	BehindBy    int        `json:"behind_by"`
	ChangedCount int       `json:"changed_count"`
	LastCommit  *GitCommit `json:"last_commit,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// GitFileStatus represents a single file in `git status --porcelain`.
type GitFileStatus struct {
	Path     string `json:"path"`
	OldPath  string `json:"old_path,omitempty"`
	Staged   string `json:"staged"`   // index character: M A D R C U ? space
	Unstaged string `json:"unstaged"` // worktree character: M D U ? space
}

// GitCommit is a single commit from `git log`.
type GitCommit struct {
	Hash      string    `json:"hash"`
	ShortHash string    `json:"short_hash"`
	Author    string    `json:"author"`
	Email     string    `json:"email"`
	Date      time.Time `json:"date"`
	Message   string    `json:"message"`
}

// GitBranch is a branch from `git branch -a`.
type GitBranch struct {
	Name     string `json:"name"`
	Current  bool   `json:"current"`
	Remote   bool   `json:"remote"`
	Tracking string `json:"tracking,omitempty"`
}

// ── Git helpers ──────────────────────────────────────────────────────────────

// gitAllowProtocol restricts git's remote transports to safe network protocols.
// It blocks remote-helper transports such as ext:: and file:: that can execute
// arbitrary commands (the classic `git clone "ext::sh -c …"` RCE). Applied to
// every git invocation that may touch a remote.
const gitAllowProtocol = "GIT_ALLOW_PROTOCOL=http:https:ssh:git"

// gitSafeEnv returns the environment for a git subprocess: no interactive
// prompts, a neutered askpass, and a protocol allowlist.
func gitSafeEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=true",
		gitAllowProtocol,
	)
}

// validateGitURL rejects URLs that could trigger argument injection (a leading
// "-" parsed as a git option) or remote-helper command execution (ext::, fd::,
// file::, etc.). scp-style git@host:path is permitted.
func validateGitURL(raw string) error {
	u := strings.TrimSpace(raw)
	if u == "" {
		return errMsg("git URL is required")
	}
	if strings.HasPrefix(u, "-") {
		return errMsg("git URL must not start with '-'")
	}
	if i := strings.Index(u, "://"); i >= 0 {
		switch strings.ToLower(u[:i]) {
		case "http", "https", "ssh", "git":
			// allowed network transports
		default:
			return errMsg("git URL scheme must be http, https, ssh or git")
		}
	} else if strings.Contains(u, "::") {
		// "<transport>::<address>" remote-helper syntax (ext::, fd::, …)
		return errMsg("invalid git URL")
	}
	return nil
}

// validateGitRef rejects branch/ref names that could be parsed as a git option.
func validateGitRef(ref string) error {
	if strings.HasPrefix(strings.TrimSpace(ref), "-") {
		return errMsg("git branch/ref must not start with '-'")
	}
	return nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// Disable interactive prompts, use a clean HOME to avoid host gitconfig, and
	// restrict remote transports to block ext::/file:: command-execution.
	cmd.Env = gitSafeEnv()
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func currentBranch(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "branch", "--show-current")
	if err != nil {
		return ""
	}
	return out
}

func configureHostedRepo(ctx context.Context, repoPath string) {
	_, _ = runGit(ctx, repoPath, "config", "http.receivepack", "true")
	_, _ = runGit(ctx, repoPath, "config", "receive.denyCurrentBranch", "updateInstead")
}

func ensureHostedRepoLink(name, repoPath string) error {
	linkPath := filepath.Join(reposRoot, name+".git")
	targetPath := filepath.Join(repoPath, ".git")

	if existing, err := os.Lstat(linkPath); err == nil {
		if existing.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(linkPath); err != nil {
				return fmt.Errorf("remove old hosted repo link: %w", err)
			}
		} else {
			return errMsg("a hosted repository already exists at " + linkPath)
		}
	}

	if err := os.Symlink(targetPath, linkPath); err != nil {
		return fmt.Errorf("create hosted repo link: %w", err)
	}

	return nil
}

func initManagedRepo(ctx context.Context, name string) (string, error) {
	if err := os.MkdirAll(reposRoot, 0755); err != nil {
		return "", fmt.Errorf("create repos dir: %w", err)
	}

	repoPath := filepath.Join(reposRoot, name)
	if _, err := os.Stat(repoPath); err == nil {
		return "", errMsg("a repo with that name already exists at " + repoPath)
	}

	out, err := runGit(ctx, reposRoot, "init", "-b", "main", name)
	if err != nil {
		return "", fmt.Errorf("git init: %s", out)
	}

	configureHostedRepo(ctx, repoPath)
	if err := ensureHostedRepoLink(name, repoPath); err != nil {
		return "", err
	}

	return repoPath, nil
}

// initProjectRepo initialises a git repo inside an existing project directory
// and creates the /data/repos/<name>.git symlink so it is served over HTTP.
func initProjectRepo(ctx context.Context, name, projectPath string) error {
	out, err := runGit(ctx, projectPath, "init", "-b", "main")
	if err != nil {
		return fmt.Errorf("git init: %s", out)
	}
	configureHostedRepo(ctx, projectPath)
	if err := ensureHostedRepoLink(name, projectPath); err != nil {
		return err
	}
	return nil
}

func parseStatus(dir string) ([]GitFileStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "status", "--porcelain=v1", "-u")
	if err != nil {
		return nil, fmt.Errorf("git status: %s", out)
	}
	if out == "" {
		return []GitFileStatus{}, nil
	}
	lines := strings.Split(out, "\n")
	files := make([]GitFileStatus, 0, len(lines))
	for _, line := range lines {
		if len(line) < 4 {
			continue
		}
		x := string(line[0])
		y := string(line[1])
		name := strings.TrimSpace(line[3:])
		oldPath := ""
		if strings.Contains(name, " -> ") {
			parts := strings.SplitN(name, " -> ", 2)
			oldPath = strings.Trim(parts[0], `"`)
			name = strings.Trim(parts[1], `"`)
		} else {
			name = strings.Trim(name, `"`)
		}
		files = append(files, GitFileStatus{
			Path:     name,
			OldPath:  oldPath,
			Staged:   x,
			Unstaged: y,
		})
	}
	return files, nil
}

func lastCommit(dir string) *GitCommit {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "log", "-1", "--format=%H|%h|%an|%ae|%aI|%s")
	if err != nil || out == "" {
		return nil
	}
	return parseCommitLine(out)
}

func parseCommitLine(line string) *GitCommit {
	parts := strings.SplitN(line, "|", 6)
	if len(parts) < 6 {
		return nil
	}
	t, _ := time.Parse(time.RFC3339, parts[4])
	return &GitCommit{
		Hash:      parts[0],
		ShortHash: parts[1],
		Author:    parts[2],
		Email:     parts[3],
		Date:      t,
		Message:   parts[5],
	}
}

func aheadBehind(dir string) (int, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		return 0, 0
	}
	parts := strings.Fields(out)
	if len(parts) != 2 {
		return 0, 0
	}
	ahead, _ := strconv.Atoi(parts[0])
	behind, _ := strconv.Atoi(parts[1])
	return ahead, behind
}

// credURLRe matches the userinfo (user:token@) portion of a URL.
var credURLRe = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// redactCreds removes embedded credentials from any URLs in git output so a
// failed push/pull does not echo the access token back to the API client.
func redactCreds(s string) string {
	return credURLRe.ReplaceAllString(s, "${1}***@")
}

// injectCreds builds an HTTPS URL with embedded credentials.
// The credentialed URL is used only for the push/pull command and never stored.
func injectCreds(remoteURL, username, token string) string {
	if username == "" || token == "" {
		return remoteURL
	}
	if strings.HasPrefix(remoteURL, "https://") {
		return "https://" + username + ":" + token + "@" + remoteURL[8:]
	}
	return remoteURL
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// Get returns a single tracked repository by ID.
func (h *GitHandlers) Get(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	repo, err := h.db.GetGitRepo(id)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repository not found"))
		return
	}
	writeJSON(w, repo)
}

// List returns all tracked repos with live status.
func (h *GitHandlers) List(w http.ResponseWriter, r *http.Request) {
	repos, err := h.db.ListGitRepos()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	result := make([]GitRepoSummary, 0, len(repos))
	for _, repo := range repos {
		files, _ := parseStatus(repo.Path)
		ahead, behind := aheadBehind(repo.Path)
		result = append(result, GitRepoSummary{
			ID:           repo.ID,
			Name:         repo.Name,
			Path:         repo.Path,
			RemoteURL:    repo.RemoteURL,
			AuthorName:   repo.AuthorName,
			AuthorEmail:  repo.AuthorEmail,
			Description:  repo.Description,
			Branch:       currentBranch(repo.Path),
			AheadBy:      ahead,
			BehindBy:     behind,
			ChangedCount: len(files),
			LastCommit:   lastCommit(repo.Path),
			CreatedAt:    repo.CreatedAt,
		})
	}
	writeJSON(w, result)
}

// Add registers an existing local path or clones a remote URL.
func (h *GitHandlers) Add(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		CloneURL    string `json:"clone_url"`
		Username    string `json:"username"`
		Token       string `json:"token"`
		AuthorName  string `json:"author_name"`
		AuthorEmail string `json:"author_email"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid request: %w", err))
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	if body.Name != filepath.Base(body.Name) || strings.Contains(body.Name, "/") || strings.Contains(body.Name, `\\`) {
		writeError(w, http.StatusBadRequest, errMsg("name must be a simple identifier"))
		return
	}

	var repoPath string
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	if body.CloneURL != "" {
		if err := validateGitURL(body.CloneURL); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := os.MkdirAll(reposRoot, 0755); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Errorf("create repos dir: %w", err))
			return
		}
		repoPath = filepath.Join(reposRoot, body.Name)
		if _, err := os.Stat(repoPath); err == nil {
			writeError(w, http.StatusConflict, errMsg("a repo with that name already exists at "+repoPath))
			return
		}
		cloneURL := injectCreds(body.CloneURL, body.Username, body.Token)
		// "--" terminates option parsing so a URL/name beginning with "-" cannot
		// be interpreted as a git flag.
		out, err := runGit(ctx, reposRoot, "clone", "--", cloneURL, body.Name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Errorf("clone failed: %s", redactCreds(out)))
			return
		}
		configureHostedRepo(ctx, repoPath)
		if err := ensureHostedRepoLink(body.Name, repoPath); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	} else if body.Path != "" {
		repoPath = body.Path
		checkCtx, checkCancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer checkCancel()
		if _, err := runGit(checkCtx, repoPath, "rev-parse", "--git-dir"); err != nil {
			writeError(w, http.StatusBadRequest, errMsg("path is not a git repository"))
			return
		}
	} else {
		var err error
		repoPath, err = initManagedRepo(ctx, body.Name)
		if err != nil {
			status := http.StatusInternalServerError
			if strings.Contains(err.Error(), "already exists") {
				status = http.StatusConflict
			}
			writeError(w, status, err)
			return
		}
	}

	repo, err := h.db.CreateGitRepo(storage.GitRepo{
		Name:        body.Name,
		Path:        repoPath,
		RemoteURL:   body.CloneURL,
		Username:    body.Username,
		Token:       body.Token,
		AuthorName:  body.AuthorName,
		AuthorEmail: body.AuthorEmail,
		Description: body.Description,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, repo)
}

// Update updates mutable metadata (author identity, description) for a repo.
func (h *GitHandlers) Update(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		AuthorName  string `json:"author_name"`
		AuthorEmail string `json:"author_email"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid request: %w", err))
		return
	}
	repo.AuthorName = body.AuthorName
	repo.AuthorEmail = body.AuthorEmail
	repo.Description = body.Description
	if err := h.db.UpdateGitRepo(*repo); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, repo)
}

// Remove un-tracks a repo. Pass ?delete_files=true to also delete the directory
// (only allowed for managed repos under /data/repos).
func (h *GitHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	repo, err := h.db.GetGitRepo(id)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	if r.URL.Query().Get("delete_files") == "true" && strings.HasPrefix(repo.Path, reposRoot) {
		_ = os.Remove(filepath.Join(reposRoot, repo.Name+".git"))
		_ = os.RemoveAll(repo.Path)
	}
	if err := h.db.DeleteGitRepo(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Status returns the working-tree status for a repo.
func (h *GitHandlers) Status(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	files, err := parseStatus(repo.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, files)
}

// Stage runs `git add` on requested files (or all files if none specified).
func (h *GitHandlers) Stage(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		Files []string `json:"files"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	args := []string{"add"}
	if len(body.Files) == 0 {
		args = append(args, "-A")
	} else {
		args = append(args, "--")
		args = append(args, body.Files...)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git add: %s", out))
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// Unstage runs `git restore --staged` on requested files (or all if none).
func (h *GitHandlers) Unstage(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		Files []string `json:"files"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	args := []string{"restore", "--staged"}
	if len(body.Files) == 0 {
		args = append(args, ".")
	} else {
		args = append(args, "--")
		args = append(args, body.Files...)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git restore --staged: %s", out))
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// Commit creates a commit from the staged changes.
func (h *GitHandlers) Commit(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		Message     string `json:"message"`
		AuthorName  string `json:"author_name"`
		AuthorEmail string `json:"author_email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Message == "" {
		writeError(w, http.StatusBadRequest, errMsg("message is required"))
		return
	}

	// Resolve author: request body > repo defaults > built-in fallback
	authorName := body.AuthorName
	if authorName == "" {
		authorName = repo.AuthorName
	}
	if authorName == "" {
		authorName = "Dockyard"
	}
	authorEmail := body.AuthorEmail
	if authorEmail == "" {
		authorEmail = repo.AuthorEmail
	}
	if authorEmail == "" {
		authorEmail = "dockyard@local"
	}

	args := []string{"commit", "-m", body.Message}
	if authorName != "" && authorEmail != "" {
		args = append(args,
			"-c", "user.name="+authorName,
			"-c", "user.email="+authorEmail,
		)
		// Prepend -c flags before "commit"
		fullArgs := []string{
			"-c", "user.name=" + authorName,
			"-c", "user.email=" + authorEmail,
			"commit", "-m", body.Message,
		}
		args = fullArgs
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git commit: %s", out))
		return
	}
	writeJSON(w, map[string]string{"output": out})
}

// Push pushes the current branch to the remote.
func (h *GitHandlers) Push(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		Remote string `json:"remote"`
		Force  bool   `json:"force"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Remote == "" {
		body.Remote = "origin"
	}

	// Build the push URL with credentials embedded
	remoteURL := repo.RemoteURL
	if remoteURL == "" {
		ctx2, c2 := context.WithTimeout(context.Background(), 5*time.Second)
		remoteURL, _ = runGit(ctx2, repo.Path, "remote", "get-url", body.Remote)
		c2()
	}
	pushURL := injectCreds(remoteURL, repo.Username, repo.Token)

	args := []string{"push", pushURL, "HEAD"}
	if body.Force {
		args = append(args, "--force")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := runGit(ctx, repo.Path, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git push: %s", redactCreds(out)))
		return
	}
	writeJSON(w, map[string]string{"output": redactCreds(out)})
}

// Pull fetches and fast-forwards the current branch.
func (h *GitHandlers) Pull(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	remoteURL := repo.RemoteURL
	if remoteURL == "" {
		ctx2, c2 := context.WithTimeout(context.Background(), 5*time.Second)
		remoteURL, _ = runGit(ctx2, repo.Path, "remote", "get-url", "origin")
		c2()
	}
	pullURL := injectCreds(remoteURL, repo.Username, repo.Token)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := runGit(ctx, repo.Path, "pull", pullURL, "--ff-only")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git pull: %s", redactCreds(out)))
		return
	}
	writeJSON(w, map[string]string{"output": redactCreds(out)})
}

// Branches lists all local and remote branches.
func (h *GitHandlers) Branches(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, "branch", "-a", "--format=%(refname:short)|%(HEAD)|%(upstream:short)")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git branch: %s", out))
		return
	}
	branches := []GitBranch{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		isRemote := strings.HasPrefix(name, "remotes/")
		if isRemote {
			name = strings.TrimPrefix(name, "remotes/")
		}
		tracking := ""
		if len(parts) == 3 {
			tracking = parts[2]
		}
		branches = append(branches, GitBranch{
			Name:     name,
			Current:  parts[1] == "*",
			Remote:   isRemote,
			Tracking: tracking,
		})
	}

	// On a freshly-initialised repo (no commits) git branch returns nothing.
	// Read the unborn branch name from HEAD so the UI can still show it.
	if len(branches) == 0 {
		if symOut, symErr := runGit(ctx, repo.Path, "symbolic-ref", "--short", "HEAD"); symErr == nil {
			name := strings.TrimSpace(symOut)
			if name != "" {
				branches = append(branches, GitBranch{Name: name, Current: true})
			}
		}
	}

	writeJSON(w, branches)
}

// Checkout switches to an existing branch or creates a new one.
func (h *GitHandlers) Checkout(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	var body struct {
		Branch string `json:"branch"`
		Create bool   `json:"create"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Branch == "" {
		writeError(w, http.StatusBadRequest, errMsg("branch is required"))
		return
	}
	args := []string{"checkout"}
	if body.Create {
		args = append(args, "-b")
	}
	args = append(args, body.Branch)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git checkout: %s", out))
		return
	}
	writeJSON(w, map[string]string{"output": out})
}

// Log returns up to `limit` recent commits (default 50, max 200).
func (h *GitHandlers) Log(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, e := strconv.Atoi(l); e == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	out, err := runGit(ctx, repo.Path, "log",
		fmt.Sprintf("-n%d", limit),
		"--format=%H|%h|%an|%ae|%aI|%s",
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git log: %s", out))
		return
	}
	commits := []GitCommit{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		if c := parseCommitLine(line); c != nil {
			commits = append(commits, *c)
		}
	}
	writeJSON(w, commits)
}

// Diff returns the unified diff for a file (or all changes) in staged or unstaged state.
func (h *GitHandlers) Diff(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	staged := r.URL.Query().Get("staged") == "true"
	file := r.URL.Query().Get("file")

	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	if file != "" {
		args = append(args, file)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	// git diff exits 0 with no output when there are no changes; ignore the error
	out, _ := runGit(ctx, repo.Path, args...)
	writeJSON(w, map[string]string{"diff": out})
}

// Fetch runs `git fetch --prune` for all remotes.
func (h *GitHandlers) Fetch(w http.ResponseWriter, r *http.Request) {
	repo, err := h.getRepo(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("repo not found"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := runGit(ctx, repo.Path, "fetch", "--prune")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("git fetch: %s", out))
		return
	}
	writeJSON(w, map[string]string{"output": out})
}

// HTTPGit serves a tracked repository through git's smart HTTP backend.
// gitAuthUser authenticates a hosted-git request via HTTP Basic auth, where the
// password must be a valid (active) Dockyard session token. The username is
// ignored, so `git clone http://x:<token>@host/git/<repo>.git` works. It returns
// the authenticated user, or nil when authentication fails.
func (h *GitHandlers) gitAuthUser(r *http.Request) *storage.User {
	_, pass, ok := r.BasicAuth()
	if !ok || pass == "" {
		return nil
	}
	user, err := h.db.GetSessionUser(pass)
	if err != nil || user == nil || !user.Active {
		return nil
	}
	return user
}

// isReceivePack reports whether a hosted-git request is a push (write) rather
// than a fetch (read), via either the smart-HTTP service query param or the
// POST path.
func isReceivePack(r *http.Request) bool {
	if r.URL.Query().Get("service") == "git-receive-pack" {
		return true
	}
	return strings.HasSuffix(r.URL.Path, "/git-receive-pack")
}

func (h *GitHandlers) HTTPGit(w http.ResponseWriter, r *http.Request) {
	// Hosted-git access requires authentication — this closes the previously
	// open (unauthenticated) clone/push endpoint.
	user := h.gitAuthUser(r)
	if user == nil {
		w.Header().Set("WWW-Authenticate", `Basic realm="Dockyard Git"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	// Pushing is a write operation: viewers (read-only) may fetch but not push,
	// matching the RBAC enforced on the REST API. Tier is resolved from the user's
	// role (system or custom) by GetSessionUser.
	if isReceivePack(r) && user.Tier != "admin" && user.Tier != "operator" {
		http.Error(w, "push requires operator or admin role", http.StatusForbidden)
		return
	}

	name := chi.URLParam(r, "name")
	if !strings.HasSuffix(strings.ToLower(name), ".git") {
		http.NotFound(w, r)
		return
	}

	lookupName := strings.TrimSuffix(name, ".git")
	repos, err := h.db.ListGitRepos()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var repo *storage.GitRepo
	for i := range repos {
		if strings.EqualFold(repos[i].Name, lookupName) {
			repo = &repos[i]
			break
		}
	}
	if repo == nil || (!strings.HasPrefix(repo.Path, reposRoot) && !strings.HasPrefix(repo.Path, projectsRoot)) {
		http.NotFound(w, r)
		return
	}

	hostedPath := filepath.Join(reposRoot, name)
	if st, statErr := os.Lstat(hostedPath); statErr != nil || st.Mode()&os.ModeSymlink == 0 {
		http.NotFound(w, r)
		return
	}

	pathInfo := "/" + name
	if rest := chi.URLParam(r, "*"); rest != "" {
		pathInfo += "/" + rest
	}
	pathTranslated := filepath.Join(reposRoot, filepath.FromSlash(strings.TrimPrefix(pathInfo, "/")))

	env := []string{
		"GIT_HTTP_EXPORT_ALL=1",
		"GIT_PROJECT_ROOT=" + reposRoot,
		"PATH_INFO=" + pathInfo,
		"PATH_TRANSLATED=" + pathTranslated,
		"REQUEST_METHOD=" + r.Method,
		"QUERY_STRING=" + r.URL.RawQuery,
		"CONTENT_TYPE=" + r.Header.Get("Content-Type"),
		"SERVER_PROTOCOL=HTTP/1.1",
		"REMOTE_ADDR=" + r.RemoteAddr,
		"HOME=/root",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
	if r.ContentLength > 0 {
		env = append(env, fmt.Sprintf("CONTENT_LENGTH=%d", r.ContentLength))
	}
	if proto := r.Header.Get("Git-Protocol"); proto != "" {
		env = append(env, "HTTP_GIT_PROTOCOL="+proto)
	}

	pr, pw := io.Pipe()
	cmd := exec.CommandContext(r.Context(), "git", "http-backend")
	cmd.Env = env
	cmd.Stdin = r.Body
	cmd.Stdout = pw
	cmd.Stderr = os.Stderr

	go func() {
		_ = pw.CloseWithError(cmd.Run())
	}()

	reader := bufio.NewReader(pr)
	statusCode := http.StatusOK
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && line == "" {
			http.Error(w, "git backend failed", http.StatusInternalServerError)
			return
		}

		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "" {
			break
		}

		if after, ok := strings.CutPrefix(trimmed, "Status: "); ok {
			parts := strings.Fields(after)
			if len(parts) > 0 {
				if code, convErr := strconv.Atoi(parts[0]); convErr == nil && code > 0 {
					statusCode = code
				}
			}
		} else if key, value, ok := strings.Cut(trimmed, ":"); ok {
			w.Header().Add(strings.TrimSpace(key), strings.TrimSpace(value))
		}

		if readErr != nil {
			break
		}
	}

	w.Header().Del("Status")
	w.WriteHeader(statusCode)
	_, _ = io.Copy(w, reader)
}

// ── Private helpers ──────────────────────────────────────────────────────────

func (h *GitHandlers) getRepo(r *http.Request) (*storage.GitRepo, error) {
	id, err := parseID(r)
	if err != nil {
		return nil, err
	}
	return h.db.GetGitRepo(id)
}

func parseID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}
