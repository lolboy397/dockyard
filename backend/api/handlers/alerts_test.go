package handlers

import "testing"

// alertTypesOfferedByUI mirrors the <option value="…"> list in
// frontend/src/app/components/alerts/alerts.component.html. Every type the
// dropdown offers MUST pass validAlertType, or Create/Update 400s a rule the UI
// just built — which is exactly the regression that shipped the (unusable)
// new_issue alert. Keep this list in sync with the template.
var alertTypesOfferedByUI = []string{
	"host_cpu",
	"host_mem",
	"host_disk",
	"container_exited",
	"new_issue",
	"error_rate",
}

func TestValidAlertTypeAcceptsEveryUIType(t *testing.T) {
	for _, typ := range alertTypesOfferedByUI {
		if !validAlertType(typ) {
			t.Errorf("validAlertType(%q) = false; the Alerts UI offers this type, so Create/Update would reject it with a 400", typ)
		}
	}
}

func TestValidAlertTypeRejectsUnknown(t *testing.T) {
	for _, typ := range []string{"", "bogus", "host_gpu", "New_Issue", "new issue"} {
		if validAlertType(typ) {
			t.Errorf("validAlertType(%q) = true; want false (unknown type)", typ)
		}
	}
}
