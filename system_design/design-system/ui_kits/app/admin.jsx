/* global React, ReactDOM, AdminSidebar, TopBar, MembersTable, MemberDetail, EditMemberModal, RolesPage, RoleDetail, CreateRoleModal, StatusBar, MEMBERS, ROLES */
const { useState: useAState } = React;

function AdminApp() {
  const [section, setSection] = useAState('members');
  const [members, setMembers] = useAState(MEMBERS);
  const [selectedId, setSelectedId] = useAState('u_jordan');
  const [filter, setFilter] = useAState('all');
  const [editing, setEditing] = useAState(false);

  const [roles, setRoles] = useAState(ROLES);
  const [selectedRoleId, setSelectedRoleId] = useAState('owner');
  const [roleFilter, setRoleFilter] = useAState('all');
  const [creatingRole, setCreatingRole] = useAState(false);

  const selected = members.find(m => m.id === selectedId);
  const selectedRole = roles.find(r => r.id === selectedRoleId);

  function handleNav(id) {
    if (id === 'members' || id === 'roles') setSection(id);
  }

  function handleSave(updated) {
    setMembers(ms => ms.map(m => (m.id === updated.id ? updated : m)));
    setEditing(false);
  }

  function handleCreateRole(role) {
    setRoles(rs => [...rs, role]);
    setRoleFilter('all');
    setSelectedRoleId(role.id);
    setCreatingRole(false);
  }

  const onRoles = section === 'roles';
  const showDetail = onRoles ? !!selectedRole : !!selected;

  return (
    <div className="app">
      <AdminSidebar section={section} onNavigate={handleNav} />
      <div className="main">
        <TopBar crumb={onRoles ? 'Roles' : 'Members'} onOpenPalette={() => {}} />
        <div className={`body ${showDetail ? '' : 'no-detail'}`}>
          {onRoles ? (
            <RolesPage
              rows={roles}
              selectedId={selectedRoleId}
              setSelectedId={setSelectedRoleId}
              filter={roleFilter}
              setFilter={setRoleFilter}
              onNewRole={() => setCreatingRole(true)}
            />
          ) : (
            <MembersTable
              rows={members}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              filter={filter}
              setFilter={setFilter}
            />
          )}
          {onRoles
            ? (showDetail && <RoleDetail role={selectedRole} onClose={() => setSelectedRoleId(null)} />)
            : (showDetail && <MemberDetail member={selected} onClose={() => setSelectedId(null)} onEdit={() => setEditing(true)} />)}
        </div>
      </div>
      <StatusBar />
      {!onRoles && editing && selected && (
        <EditMemberModal member={selected} onClose={() => setEditing(false)} onSave={handleSave} />
      )}
      {onRoles && creatingRole && (
        <CreateRoleModal onClose={() => setCreatingRole(false)} onCreate={handleCreateRole} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AdminApp />);
