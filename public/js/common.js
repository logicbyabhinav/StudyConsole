// Immediately apply saved theme on load to prevent light-flash
(function () {
  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
})();

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", href: "dashboard.html" },
  { key: "students", label: "Students", href: "students.html" },
  { key: "seats", label: "Seat map", href: "seats.html" },
  { key: "payments", label: "Payments", href: "payments.html" },
  { key: "reallocations", label: "Reallocations", href: "reallocations.html" },
  { key: "messages", label: "Messages", href: "messages.html" },
  { key: "attendance", label: "Attendance", href: "attendance.html" },
  { key: "settings", label: "Settings", href: "settings.html" },
];

function renderShell(activeKey, pageTitle, pageSub) {
  // Inject Google Fonts dynamically
  if (!document.getElementById("google-fonts-links")) {
    const fontLink1 = document.createElement("link");
    fontLink1.rel = "preconnect";
    fontLink1.href = "https://fonts.googleapis.com";
    document.head.appendChild(fontLink1);

    const fontLink2 = document.createElement("link");
    fontLink2.rel = "preconnect";
    fontLink2.href = "https://fonts.gstatic.com";
    fontLink2.crossOrigin = "anonymous";
    document.head.appendChild(fontLink2);

    const fontLink3 = document.createElement("link");
    fontLink3.rel = "stylesheet";
    fontLink3.id = "google-fonts-links";
    fontLink3.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap";
    document.head.appendChild(fontLink3);
  }

  document.getElementById("shell").className = "app-shell";

  const navHtml = NAV_ITEMS.map(
    (item) =>
      `<a class="nav-item ${item.key === activeKey ? "active" : ""}" href="${item.href}">${item.label}</a>`,
  ).join("");

  document.getElementById("shell").innerHTML = `
    <div class="sidebar">
      <div class="brand">
        <div>
          <div class="name" style="font-size:17px;font-weight:800;letter-spacing:-0.04em;background:linear-gradient(135deg,#0969da 0%,#10b981 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.15;">StudyConsole</div>
          <div class="sub">Admin Console</div>
        </div>
      </div>
      <div class="nav-section">${navHtml}</div>
      <div style="margin-top: auto; padding: 1.25rem 1rem; border-top: 1px solid var(--border-soft); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <span style="font-size: 11px; color: var(--text-muted); font-weight: 500;">Appearance</span>
        <button id="themeToggleBtn" class="theme-toggle-btn" aria-label="Toggle theme" style="background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text); transition: background 0.12s, border-color 0.12s;">
          <!-- Sun SVG (shows in Dark mode to switch to Light) -->
          <svg class="sun-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          <!-- Moon SVG (shows in Light mode to switch to Dark) -->
          <svg class="moon-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        </button>
      </div>
    </div>
    <div class="main">
      <div class="institute-topbar" id="instituteTopbar">
        <span class="institute-topbar-name" id="instituteNameDisplay">Loading&hellip;</span>
        <div style="display:flex; align-items:center; gap:10px; margin-left:auto;">
          <span class="institute-topbar-badge">Admin Console</span>
          <button id="adminLogoutBtn" title="Logout" style="display:flex;align-items:center;gap:6px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--red,#cf222e);background:transparent;border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:background 0.15s,border-color 0.15s;" onmouseover="this.style.background='var(--red-light,rgba(207,34,46,0.07))'" onmouseout="this.style.background='transparent'">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Logout
          </button>
        </div>
      </div>
      <div class="page">
        <h2 class="page-title">${pageTitle}</h2>
        ${pageSub ? `<p class="page-sub">${pageSub}</p>` : ""}
        <div id="page-content"></div>
      </div>
    </div>
  `;

  // Admin logout button handler
  document
    .getElementById("adminLogoutBtn")
    .addEventListener("click", async () => {
      try {
        await fetch("/api/student/logout", { method: "POST" });
      } finally {
        sessionStorage.clear();
        window.location.href = "/login.html";
      }
    });

  // Dynamic theme management
  const toggleBtn = document.getElementById("themeToggleBtn");
  const sunIcon = toggleBtn.querySelector(".sun-icon");
  const moonIcon = toggleBtn.querySelector(".moon-icon");

  function updateIcons(theme) {
    if (theme === "dark") {
      sunIcon.style.display = "block";
      moonIcon.style.display = "none";
    } else {
      sunIcon.style.display = "none";
      moonIcon.style.display = "block";
    }
  }

  const currentTheme =
    document.documentElement.getAttribute("data-theme") || "light";
  updateIcons(currentTheme);

  toggleBtn.addEventListener("click", () => {
    const activeTheme =
      document.documentElement.getAttribute("data-theme") || "light";
    const nextTheme = activeTheme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("theme", nextTheme);
    updateIcons(nextTheme);
  });

  // Load institute name from cache or API
  const cached = sessionStorage.getItem("institute_name");
  if (cached) {
    _setInstituteName(cached);
  } else {
    api("/app-settings")
      .then((s) => {
        const name = s.institute_name || "Study Centre";
        sessionStorage.setItem("institute_name", name);
        _setInstituteName(name);
      })
      .catch(() => _setInstituteName("Study Centre"));
  }
}

function _setInstituteName(name) {
  const el = document.getElementById("instituteNameDisplay");
  if (el) el.textContent = name;

  if (document.title && document.title.includes("—")) {
    const parts = document.title.split("—");
    document.title = `${parts[0].trim()} — ${name}`;
  }
}

async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options,
  });
  // Session expired or invalid — redirect to login
  if (res.status === 401) {
    sessionStorage.clear();
    window.location.href = "/login.html";
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------- Shared student lifecycle helpers ----------
const STATUS_BADGE_CLASS = {
  Active: "badge-green",
  Overdue: "badge-red",
  Suspended: "badge-orange",
  Archived: "badge-gray",
};

const INACTIVE_STATUSES = ["Suspended", "Archived"];
const REACTIVATABLE_STATUSES = ["Suspended"];

function statusBadge(status) {
  const cls = STATUS_BADGE_CLASS[status] || "badge-gray";
  return `<span class="badge ${cls}">${status}</span>`;
}

function isInactiveStatus(status) {
  return INACTIVE_STATUSES.includes(status);
}

function canReactivateStatus(status) {
  return REACTIVATABLE_STATUSES.includes(status);
}

// Sleek custom modal alert (overlay)
function customAlert(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "9999";

    overlay.innerHTML = `
      <div class="modal-card" style="max-width: 440px; padding: 24px;">
        <h3 style="margin: 0 0 12px; font-size: 16px; font-weight: 700; color: var(--text);">${title}</h3>
        <p style="margin: 0 0 20px; font-size: 13.5px; line-height: 1.5; color: var(--text-muted);">${message}</p>
        <div style="display: flex; justify-content: flex-end;">
          <button class="btn btn-primary" id="customAlertOkBtn" style="padding: 6px 16px; font-size: 12.5px;">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector("#customAlertOkBtn");
    okBtn.focus();

    okBtn.onclick = () => {
      overlay.remove();
      resolve();
    };
  });
}

// Sleek custom modal confirm (overlay)
function customConfirm(
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "9999";

    overlay.innerHTML = `
      <div class="modal-card" style="max-width: 440px; padding: 24px;">
        <h3 style="margin: 0 0 12px; font-size: 16px; font-weight: 700; color: var(--text);">${title}</h3>
        <p style="margin: 0 0 20px; font-size: 13.5px; line-height: 1.5; color: var(--text-muted);">${message}</p>
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button class="btn btn-secondary" id="customConfirmCancelBtn" style="padding: 6px 14px; font-size: 12.5px;">${cancelText}</button>
          <button class="btn btn-primary" id="customConfirmOkBtn" style="padding: 6px 16px; font-size: 12.5px;">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector("#customConfirmCancelBtn");
    const okBtn = overlay.querySelector("#customConfirmOkBtn");

    okBtn.focus();

    cancelBtn.onclick = () => {
      overlay.remove();
      resolve(false);
    };

    okBtn.onclick = () => {
      overlay.remove();
      resolve(true);
    };
  });
}

// Sleek custom modal prompt (overlay)
function customPrompt(title, message, placeholder = "", defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "9999";

    overlay.innerHTML = `
      <div class="modal-card" style="max-width: 440px; padding: 24px;">
        <h3 style="margin: 0 0 12px; font-size: 16px; font-weight: 700; color: var(--text);">${title}</h3>
        <p style="margin: 0 0 16px; font-size: 13.5px; line-height: 1.5; color: var(--text-muted);">${message}</p>
        <div style="margin-bottom: 20px;">
          <input type="text" id="customPromptInput" placeholder="${placeholder}" value="${defaultValue}" style="width: 100%; box-sizing: border-box;">
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button class="btn btn-secondary" id="customPromptCancelBtn" style="padding: 6px 14px; font-size: 12.5px;">Cancel</button>
          <button class="btn btn-primary" id="customPromptOkBtn" style="padding: 6px 16px; font-size: 12.5px;">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector("#customPromptInput");
    const cancelBtn = overlay.querySelector("#customPromptCancelBtn");
    const okBtn = overlay.querySelector("#customPromptOkBtn");

    input.focus();
    if (defaultValue) {
      input.setSelectionRange(0, defaultValue.length);
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        okBtn.click();
      } else if (e.key === "Escape") {
        cancelBtn.click();
      }
    });

    cancelBtn.onclick = () => {
      overlay.remove();
      resolve(null);
    };

    okBtn.onclick = () => {
      const val = input.value;
      overlay.remove();
      resolve(val);
    };
  });
}

// Global premium toast notification system (Dynamic DOM generation)
function showToast(msg, type = "success") {
  // type: 'success' (green dot) | 'info' (blue dot) | 'error' (red dot)
  const dotColors = { success: "#2ea043", info: "#0969da", error: "#cf222e" };
  const dotColor = dotColors[type] || dotColors.success;
  const duration = type === "info" ? 2500 : 3500;

  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <span class="toast-dot" style="background:${dotColor};box-shadow:0 0 0 3px ${dotColor}22;"></span>
    <span>${msg}</span>
  `;

  container.appendChild(toast);

  // Trigger entry animation
  setTimeout(() => {
    toast.classList.add("show");
  }, 10);

  // Slide out and remove
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 250);
  }, duration);
}

// Setup EventSource for real-time live updates and toast notifications
(function () {
  const source = new EventSource("/api/live-stream");
  source.addEventListener("change", (event) => {
    try {
      const data = JSON.parse(event.data);
      // If it is a code reload signal, reload the browser instantly
      if (data.type === "reload") {
        console.log(
          "[watcher] Live reload triggered by frontend asset change...",
        );
        location.reload();
        return;
      }
      // Auto-trigger toast if a descriptive message is broadcast
      if (data.message) {
        showToast(data.message);
      }
      // Invoke page-level live update handlers to refresh views instantly without reloading
      if (typeof window.onLiveUpdate === "function") {
        window.onLiveUpdate(data);
      }
    } catch (err) {
      console.error("Error handling live update:", err);
    }
  });

  // Bug 8 fix: on any connection error (e.g. 401 after session expiry) close the
  // EventSource immediately instead of letting the browser retry every 3 seconds
  // forever, hammering the server with unauthenticated requests.
  source.onerror = () => {
    source.close();
    fetch("/api/live-stream", { method: "HEAD" })
      .then((r) => {
        if (r.status === 401) {
          sessionStorage.clear();
          window.location.href = "/login.html";
        }
      })
      .catch(() => {});
  };

  // Explicitly close EventSource on page unload to free up browser connection slots instantly
  window.addEventListener("beforeunload", () => {
    source.close();
  });
})();
