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
    const slug = `${email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
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

let currentProjectId = null;



async function loadReports(project) {
  currentProjectId = project.id;
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
  loadIntegrations().catch((err) => {
    $("integration-error").textContent = `Load failed (${err.status})`;
  });
}

async function loadIntegrations() {
  $("integration-error").textContent = "";
  const integrations = await api(
    `/api/v1/projects/${currentProjectId}/integrations`,
  );
  $("integration-rows").replaceChildren(
    ...integrations.map((i) => {
      const tr = document.createElement("tr");
      const td = (text) => {
        const cell = document.createElement("td");
        cell.textContent = text ?? "";
        return cell;
      };
      const enabledCell = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = i.enabled;
      cb.onchange = async () => {
        try {
          await api(`/api/v1/integrations/${i.id}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: cb.checked }),
          });
        } catch (err) {
          cb.checked = !cb.checked;
          $("integration-error").textContent = `Update failed (${err.status})`;
        }
      };
      enabledCell.append(cb);
      const delCell = document.createElement("td");
      const del = document.createElement("button");
      del.textContent = "delete";
      del.onclick = async () => {
        $("integration-error").textContent = "";
        try {
          await api(`/api/v1/integrations/${i.id}`, { method: "DELETE" });
          await loadIntegrations();
        } catch (err) {
          $("integration-error").textContent = `Delete failed (${err.status})`;
        }
      };
      delCell.append(del);
      tr.append(
        td(i.provider),
        enabledCell,
        td(Object.keys(i.config ?? {}).join(", ") || "—"),
        delCell,
      );
      return tr;
    }),
  );
}


$("integration-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("integration-error").textContent = "";
  const { provider, config } = Object.fromEntries(new FormData(e.target));
  try {
    let parsed = {};
    try {
      parsed = config.trim() ? JSON.parse(config) : {};
    } catch {
      $("integration-error").textContent = "Config must be valid JSON";
      return;
    }
    await api(`/api/v1/projects/${currentProjectId}/integrations`, {
      method: "POST",
      body: JSON.stringify({ provider, config: parsed }),
    });
    e.target.reset();
    await loadIntegrations();
  } catch (err) {
    $("integration-error").textContent = `Save failed (${err.status})`;
  }
});

$("reports-back").onclick = () => loadProjects();

// resume existing session if the cookie is still valid
loadProjects().catch(() => show("auth"));
