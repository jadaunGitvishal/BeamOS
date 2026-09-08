// Placeholder landing screen. Stage B2 replaces this with the technician's
// workspace/device picker and the field-visit form.
export default function HomeScreen({ me, onLogout }) {
  const name = me?.name?.trim() || me?.email || "technician";
  return (
    <main className="screen">
      <div className="card">
        <h1 className="brand">BeamOS Field Tech</h1>
        <p className="lead">Logged in as <strong>{name}</strong></p>
        <dl className="kv">
          {me?.email && (
            <>
              <dt>Email</dt>
              <dd>{me.email}</dd>
            </>
          )}
          {me?.role && (
            <>
              <dt>Role</dt>
              <dd>{me.role}</dd>
            </>
          )}
        </dl>
        <p className="muted">
          The visit workflow is coming next. For now this just confirms sign-in works.
        </p>
        <button className="button button--secondary" type="button" onClick={onLogout}>
          Log out
        </button>
      </div>
    </main>
  );
}
