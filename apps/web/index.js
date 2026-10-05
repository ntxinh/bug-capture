const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ["auth", "projects", "reports"]) {
    $(s).classList.toggle("hidden", s !== id);
  }
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = new Error(`${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function ensureOrg(name, email) {
  const orgs = await api("/api/auth/organization/list");
  let orgId = orgs?.[0]?.id;
  if (!orgId) {
    const slug = `${email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
    const org = await api("/api/auth/organization/create", {
      method: "POST",
      body: JSON.stringify({ name: name || slug, slug }),
    });
    orgId = org.id;
  }
  await api("/api/auth/organization/set-active", {
    method: "POST",
    body: JSON.stringify({ organizationId: orgId }),
  });
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("auth-error").textContent = "";
  const { name, email, password } = Object.fromEntries(new FormData(e.target));
  try {
    try {
      await api("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      if (err.status !== 401) throw err;
      await api("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ email, password, name: name || email }),
      });
    }
    await ensureOrg(name, email);
    await loadProjects();
  } catch (err) {
    $("auth-error").textContent = `Auth failed (${err.status})`;
  }
});

async function loadProjects() {
  const projects = await api("/api/v1/projects");
  $("project-list").replaceChildren(
    ...projects.map((p) => {
      const li = document.createElement("li");
      li.textContent = `${p.name} `;
      const btn = document.createElement("button");
      btn.textContent = "reports";
      btn.onclick = () => loadReports(p);
      li.append(btn);
      return li;
    }),
  );
  show("projects");
}

$("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("project-error").textContent = "";
  const { name, slug } = Object.fromEntries(new FormData(e.target));
  try {
    await api("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    e.target.reset();
    await loadProjects();
  } catch (err) {
    $("project-error").textContent = `Create failed (${err.status})`;
  }
});

async function loadReports(project) {
  $("reports-project").textContent = project.name;
  const reports = await api(`/api/v1/reports?projectId=${project.id}`);
  $("report-rows").replaceChildren(
    ...reports.map((r) => {
      const tr = document.createElement("tr");
      const td = (text) => {
        const cell = document.createElement("td");
        cell.textContent = text ?? "";
        return cell;
      };
      const title = document.createElement("td");
      const a = document.createElement("a");
      a.href = `/app/report.html?id=${r.id}`;
      a.textContent = r.title;
      title.append(a);
      tr.append(
        title,
        td(r.status),
        td(r.priority),
        td(new Date(r.createdAt).toLocaleString()),
      );
      return tr;
    }),
  );
  show("reports");
}

$("reports-back").onclick = () => loadProjects();

// resume existing session if the cookie is still valid
loadProjects().catch(() => show("auth"));
