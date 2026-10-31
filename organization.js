/* Organization demo workspace. Server permissions remain authoritative. */
"use strict";
(() => {
  const ROOT = "/api/v1/organization";
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { organization: null, user: null, units: [], unitId: null, page: "overview", epoch: 0, patient: null, patientTab: "", from: "", to: "", metricScope: "all", settingsScope: "clinic" };
  const modal = $("#modal");
  let modalReturnFocus;
  const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
  const dateTime = value => value ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  function node(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === "class") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key === "readonly") element.readOnly = Boolean(value);
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else if (["value", "checked", "disabled", "hidden", "required", "selected"].includes(key)) element[key] = value;
      else element.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return element;
  }
  const button = (text, action, style = "secondary", attrs = {}) => node("button", { type: "button", class: style, onclick: action, ...attrs }, text);
  const badge = (text, style = "") => node("span", { class: `badge ${style}` }, text);
  const field = (label, name, attrs = {}) => { const { multiline, class: layout, ...inputAttrs } = attrs; return node("label", { class: layout }, label, node(multiline ? "textarea" : "input", { name, ...inputAttrs })); };
  function selectField(label, name, options, value, attrs = {}) {
    const select = node("select", { name, ...attrs }, options.map(option => node("option", { value: option.value, selected: String(option.value) === String(value) }, option.label)));
    return node("label", {}, label, select);
  }
  const values = form => Object.fromEntries(new FormData(form));
  const unit = () => state.units.find(item => item.id === state.unitId);
  const unitName = () => unit()?.name || "No clinic selected";
  const list = value => Array.isArray(value) ? value : [];
  const textValue = value => typeof value === "string" ? value : value == null ? "—" : JSON.stringify(value, null, 2);
  const scopeNote = () => node("div", { class: "scope-note" }, `Working clinic: ${unitName()} · This action stays with this clinic.`);
  const cell = (main, secondary) => node("div", { class: "cell-main" }, main, secondary ? node("span", { class: "cell-secondary" }, secondary) : null);
  function table(headers, rows, emptyText = "No records to show.") {
    return rows.length ? node("div", { class: "table-scroll" }, node("table", {}, node("thead", {}, node("tr", {}, headers.map(header => node("th", { scope: "col" }, header)))), node("tbody", {}, rows.map(row => node("tr", {}, row.map(content => node("td", {}, content))))))) : empty("Nothing here yet", emptyText);
  }
  function empty(title, text, action) { return node("div", { class: "empty" }, node("h3", {}, title), node("p", {}, text), action); }
  function card(title, description, body, action) { return node("section", { class: "card" }, node("div", { class: "card-head" }, node("div", {}, node("h2", {}, title), description ? node("p", {}, description) : null), action), body); }
  function notify(message, kind = "") {
    const feedback = $("#page-feedback");
    feedback.className = `feedback ${kind}`; feedback.textContent = message; feedback.hidden = !message;
    $("#announcer").textContent = message;
  }
  function heading(title, description, actions = []) {
    $("#page-heading").replaceChildren(node("div", {}, node("span", { class: "eyebrow" }, state.organization?.name || "ORGANIZATION"), node("h1", {}, title), node("p", {}, description)), node("div", { class: "heading-actions" }, actions));
  }
  function showLogin() {
    state.user = null; state.epoch++; state.patient = null;
    $("#workspace").hidden = true; $("#login-screen").hidden = false;
    $("#page-content").replaceChildren(); $("#page-heading").replaceChildren();
    if (modal.open) modal.close();
  }
  async function api(path, body, options = {}) {
    const url = path.startsWith("/api/") ? path : `${ROOT}${path}`;
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || `Request failed (${response.status}). Please try again.`);
      error.code = data.error?.code; error.status = response.status;
      if (response.status === 401 && !options.quiet) showLogin();
      throw error;
    }
    return data;
  }
  function errorText(error) { return error.status === 409 ? `${error.message} This action was not saved. Your entries are still here; review the conflict before trying again.` : error.message || "The request could not be completed. Please try again."; }
  function closeModal() { if (modal.open) modal.close(); }
  function requestCloseModal() { if (modal.dataset.busy !== "true") closeModal(); }
  function openModal(title, description, body) {
    modalReturnFocus = document.activeElement;
    $("#modal-content").replaceChildren(node("div", { class: "modal-header" }, node("div", {}, node("h2", { id: "modal-title" }, title), node("p", {}, description)), button("×", requestCloseModal, "modal-close", { "aria-label": "Close dialog" })), node("div", { class: "modal-body" }, body));
    if (!modal.open) modal.showModal();
  }
  modal.addEventListener("cancel", event => { if (modal.dataset.busy === "true") event.preventDefault(); });
  modal.addEventListener("close", () => { modal.dataset.busy = "false"; if (modalReturnFocus?.isConnected) modalReturnFocus.focus(); });
  function formDialog(title, description, fields, submit, label = "Save", scope = true) {
    const error = node("p", { class: "error", role: "alert", hidden: true, tabindex: "-1" });
    const submitButton = node("button", { type: "submit", class: "primary" }, label);
    const form = node("form", {}, scope ? scopeNote() : null, node("div", { class: "form-grid" }, fields), error, node("div", { class: "form-actions" }, button("Cancel", requestCloseModal), submitButton));
    const capturedUnit = state.unitId;
    form.addEventListener("submit", async event => {
      event.preventDefault(); error.hidden = true; submitButton.disabled = true; modal.dataset.busy = "true";
      try {
        if (scope && capturedUnit !== state.unitId) throw new Error("The working clinic changed. Close this form and start again in the correct clinic.");
        await submit(values(form), form, capturedUnit);
      } catch (failure) { error.textContent = errorText(failure); error.hidden = false; error.focus(); }
      finally { submitButton.disabled = false; modal.dataset.busy = "false"; }
    });
    openModal(title, description, form);
    return form;
  }
  function has(permission, unitId = state.unitId) {
    return list(state.user?.permissions).includes(permission) || list(state.units.find(item => item.id === unitId)?.permissions).includes(permission);
  }
  function any(permission) { return list(state.user?.permissions).includes(permission) || state.units.some(item => list(item.permissions).includes(permission)); }
  function query(params) { return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")).toString(); }
  function navigate(page, patient = null) { if (patient?.id !== state.patient?.id) state.patientTab = ""; state.page = page; state.patient = patient; sessionStorage.setItem("organization-page", page); render(); }
  const navigation = [
    ["overview", "Overview", "◫"], ["patients", "Patients", "♧"], ["appointments", "Appointments", "▦"],
    ["forms", "Forms & templates", "▤"], ["staff", "People & access", "♙"], ["settings", "Settings", "⚙"], ["audit", "Activity log", "≡"]
  ];
  function navigationVisible(page) {
    if (page === "patients") return any("patients:read");
    if (page === "appointments") return any("appointments:read");
    if (page === "forms") return any("forms:manage") || any("forms:fill");
    if (page === "staff") return any("access:manage");
    if (page === "audit") return any("audit:read");
    if (page === "settings") return any("settings:manage") || any("settings:write");
    return true;
  }
  async function startSession(data) {
    state.user = data.user; state.units = list(data.units);
    const stored = sessionStorage.getItem(`organization-clinic-${state.organization?.code || "current"}`);
    state.unitId = state.units.some(item => item.id === stored) ? stored : state.units[0]?.id || null;
    const defaultPage = any("metrics:read") || any("finance:read") ? "overview" : any("patients:read") ? "patients" : any("settings:manage") || any("settings:write") ? "settings" : any("appointments:read") ? "appointments" : "overview";
    state.page = sessionStorage.getItem("organization-page") || defaultPage;
    if (!navigationVisible(state.page) || (state.page === "overview" && !any("metrics:read") && !any("finance:read"))) state.page = defaultPage;
    $("#organization-name").textContent = state.organization?.name || "Organization";
    $("#account-name").textContent = state.user.display_name;
    $("#clinic-select").replaceChildren(...state.units.map(item => node("option", { value: item.id, selected: item.id === state.unitId }, item.name)));
    $("#clinic-select").hidden = state.units.length <= 1;
    $("#single-clinic").hidden = state.units.length > 1;
    $("#single-clinic").textContent = state.units[0]?.name || "No clinic access";
    $("#login-screen").hidden = true; $("#workspace").hidden = false;
    $("#login-form").reset(); await render();
  }
  $("#clinic-select").addEventListener("change", event => {
    closeModal(); state.unitId = event.target.value;
    sessionStorage.setItem(`organization-clinic-${state.organization?.code || "current"}`, state.unitId);
    render();
  });
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault(); const submit = $("button[type=submit]", event.target); const error = $("#login-error");
    error.hidden = true; submit.disabled = true;
    try { await startSession(await api("/api/v1/auth/login", values(event.target), { quiet: true })); }
    catch (failure) { error.textContent = errorText(failure); error.hidden = false; }
    finally { submit.disabled = false; }
  });
  $("#logout-button").addEventListener("click", async () => {
    try { await api("/api/v1/auth/logout", {}); sessionStorage.removeItem("organization-page"); showLogin(); }
    catch (failure) { notify(errorText(failure), "error"); }
  });
  async function render() {
    const epoch = ++state.epoch;
    notify("");
    $("#navigation").replaceChildren(...navigation.filter(([page]) => navigationVisible(page)).map(([page, label, icon]) => button([node("span", { class: "nav-icon", "aria-hidden": "true" }, icon), label], () => navigate(page), "nav-button", { "aria-current": state.page === page ? "page" : "false" })));
    const host = $("#page-content"); host.replaceChildren(node("div", { class: "loading", role: "status" }, "Loading workspace…"));
    try {
      let content;
      if (state.patient && state.page === "patients") content = await patientProfile(epoch);
      else content = await ({ overview: overviewPage, patients: patientsPage, appointments: appointmentsPage, forms: formsPage, staff: staffPage, settings: settingsPage, audit: auditPage }[state.page] || overviewPage)(epoch);
      if (epoch !== state.epoch || !state.user) return;
      host.replaceChildren(content); $("#announcer").textContent = `${state.page} loaded. Working clinic: ${unitName()}.`;
    } catch (failure) {
      if (epoch !== state.epoch || !state.user) return;
      host.replaceChildren(empty(failure.status === 403 ? "This view needs permission" : "We couldn’t load this view", errorText(failure), button("Try again", render)));
    }
  }
  function periodDefaults() {
    if (!state.to) { state.to = today(); const year = Number(state.to.slice(0, 4)) - (Number(state.to.slice(5, 7)) < 4 ? 1 : 0); state.from = `${year}-04-01`; }
  }
  async function overviewPage(epoch) {
    if (!any("metrics:read") && !any("finance:read")) {
      heading("Your clinic workspace", `Welcome, ${state.user.display_name}. Keep the working clinic in view as you continue.`);
      const links = navigation.filter(([page]) => page !== "overview" && navigationVisible(page)).map(([page, label]) => {
        const descriptions = { patients: "Find or register a shared patient identity, then continue their care.", appointments: "Review the clinic diary and reserve time with a doctor.", forms: "Browse the current forms assigned to your clinic.", settings: "Review inherited settings and permitted local overrides." };
        return card(label, descriptions[page] || "Open your permitted workspace.", node("div", { class: "card-pad" }, button(`Open ${label.toLowerCase()} →`, () => navigate(page))));
      });
      return node("div", {}, node("section", { class: "overview-welcome" }, node("div", {}, node("h2", {}, unitName()), node("p", {}, "Your clinic context stays in this tab. Every record is saved against an explicit clinic.")), badge("Synthetic demonstration")), node("div", { class: "grid two" }, links));
    }
    heading("A clear view of your practice", "Organization and clinic activity, together in one place."); periodDefaults();
    const data = await api(`/metrics?${query({ from: state.from, to: state.to, unit_id: state.metricScope === "unit" ? state.unitId : undefined })}`);
    if (epoch !== state.epoch) return null;
    const filters = node("form", { class: "toolbar" }, field("From", "from", { type: "date", required: true, value: state.from }), field("Through", "to", { type: "date", required: true, value: state.to }), selectField("Reporting scope", "scope", [{ value: "all", label: "Organization scope" }, { value: "unit", label: "Working clinic" }], state.metricScope), node("button", { type: "submit", class: "secondary" }, "Apply filters"));
    filters.addEventListener("submit", event => { event.preventDefault(); const date = values(filters); if (date.from > date.to) return notify("The start date must be on or before the end date.", "error"); state.from = date.from; state.to = date.to; state.metricScope = date.scope; render(); });
    const metric = (label, value, note) => node("div", { class: "metric" }, node("span", { class: "metric-label" }, label), node("strong", {}, value), node("small", {}, note));
    return node("div", {}, node("section", { class: "overview-welcome" }, node("div", {}, node("h2", {}, `Welcome, ${state.user.display_name.split(" ")[0]}.`), node("p", {}, `${state.units.length} accessible ${state.units.length === 1 ? "clinic" : "clinics"} · Your working clinic is ${unitName()}.`)), badge("Connected care")),
      node("div", { class: "metrics" }, metric("Unique active patients", data.unique_active_patients ?? "—", "Deduplicated across selected clinics"), metric("Registered patients", data.unique_patients ?? "—", `${data.registrations ?? "—"} new clinic registrations in period`), metric("Appointments", data.appointments ?? "—", "Across permitted clinics"), metric("Collections", data.collections == null ? "—" : money(data.collections), "Voided receipts excluded")),
      card("Clinic performance", `${data.from || state.from} to ${data.to || state.to} · ${data.timezone || "Asia/Kolkata"} · ${data.currency || "INR"}`, node("div", {}, filters, table(["Clinic", "Active patients", "Registrations", "Appointments", "Collections"], list(data.units).map(item => [cell(item.name, item.id === state.unitId ? "Current working clinic" : ""), item.active_patients, item.registrations, item.appointments, money(item.collections)]), "No clinic activity is available in this period."))),
      node("p", { class: "fine-print metrics-note" }, `Generated ${dateTime(data.generated_at)}. A patient active in two clinics counts once in organization totals.`));
  }
  async function patientsPage() {
    heading("Patients", "Find a shared identity. Open only the clinic history you are permitted to see.", has("patients:write") ? [button("+ Register patient", registerPatient, "primary")] : []);
    const mode = selectField("Search by", "mode", [{ value: "uhid", label: "Exact UHID" }, { value: "phone", label: "Phone + name" }], "uhid");
    const lookup = field("UHID", "lookup", { required: true, placeholder: "Enter full UHID", autocomplete: "off" });
    const name = field("Confirm patient name", "name", { placeholder: "Name associated with this phone" }); name.hidden = true;
    const results = node("div", {}, empty("Find the person, then continue their care", "Search an exact UHID, or enter their phone number and confirm their name. The shared directory does not expose other clinics’ history."));
    const form = node("form", { class: "toolbar" }, mode, lookup, name, node("button", { class: "primary", type: "submit" }, "Find patient"));
    $("select", mode).addEventListener("change", event => { const phone = event.target.value === "phone"; lookup.firstChild.textContent = phone ? "Exact phone" : "UHID"; $("input", lookup).placeholder = phone ? "Enter full phone number" : "Enter full UHID"; name.hidden = !phone; $("input", name).required = phone; });
    form.addEventListener("submit", async event => {
      event.preventDefault(); const scope = state.epoch; const input = values(form); const submit = $("button", form); submit.disabled = true;
      try {
        const data = await api(`/patients?${query(input.mode === "uhid" ? { uhid: input.lookup.trim() } : { phone: input.lookup.trim(), name: input.name.trim() })}`);
        if (scope !== state.epoch) return;
        results.replaceChildren(table(["Patient", "UHID", "Phone", ""], list(data.patients).map(patient => [cell(patient.name, "Shared organization identity"), node("span", { class: "code-label" }, patient.uhid), patient.phone, button("Open profile →", () => navigate("patients", patient), "secondary button-small")]), "No matching patient was found. Check the details or register a new patient."));
      } catch (failure) { if (scope === state.epoch) notify(errorText(failure), "error"); }
      finally { submit.disabled = false; }
    });
    return card("Organization patient directory", "Discovery is separate from clinical and financial access.", node("div", {}, form, results));
  }
  function patientFields(patient = {}) {
    return [field("Full name", "name", { required: true, maxlength: 120, value: patient.name || "", autocomplete: "name", class: "full" }), field("Phone", "phone", { required: true, maxlength: 30, value: patient.phone || "", inputmode: "tel", autocomplete: "tel" }), selectField("Gender", "gender", [{ value: "", label: "Not recorded" }, { value: "unspecified", label: "Unspecified" }, { value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "other", label: "Other" }], patient.gender || ""), field("Date of birth", "dob", { type: "date", value: patient.dob ? String(patient.dob).slice(0, 10) : "", max: today() })];
  }
  function registerPatient() {
    formDialog("Register patient", "One shared identity across this organization’s clinics.", patientFields(), async (input, form, unit_id) => {
      const data = await api("/patients", { unit_id, ...input, dob: input.dob || undefined, gender: input.gender || undefined });
      closeModal(); navigate("patients", data.patient); if (data.duplicate_warning) notify("Patient registered. Another patient uses this phone number; check the identity before continuing. No records were merged.", "warning");
    }, "Register patient");
  }
  function editPatient(patient) {
    const form = formDialog("Edit shared identity", "Changes apply across this organization. Existing clinical records stay unchanged.", patientFields(patient), async (input, edit, unit_id) => {
      const data = await api(`/patients/${encodeURIComponent(patient.id)}`, { unit_id, version: patient.version, ...input, dob: input.dob || undefined, gender: input.gender || undefined });
      closeModal(); state.patient = data.patient; await render(); notify("Patient identity updated.");
    }, "Save identity");
    $(".form-actions", form).prepend(button("Reload latest", async () => { try { const latest = await api(`/patients/${encodeURIComponent(patient.id)}?${query({ unit_id: state.unitId })}`); editPatient(latest.patient); } catch (failure) { notify(errorText(failure), "error"); } }));
  }
  async function patientProfile(epoch) {
    const id = state.patient.id;
    const data = await api(`/patients/${encodeURIComponent(id)}?${query({ unit_id: state.unitId })}`);
    if (epoch !== state.epoch) return null;
    state.patient = data.patient;
    const patient = data.patient;
    heading("Patient profile", "Shared identity, with care and billing attributed to the working clinic.", [button("← Patient search", () => navigate("patients"))]);
    const content = node("div", {});
    const profile = node("section", { class: "profile-banner" }, node("div", { class: "avatar", "aria-hidden": "true" }, patient.name.split(/\s+/).map(word => word[0]).slice(0, 2).join("")), node("div", {}, node("h2", {}, patient.name), node("div", { class: "profile-meta" }, node("span", { class: "code-label" }, patient.uhid), node("span", {}, patient.phone), node("span", {}, patient.gender || "Gender not recorded"))), node("div", { class: "profile-actions" }, has("patients:write") ? button("Edit identity", () => editPatient(patient)) : null, has("appointments:write") ? button("Book appointment", () => bookAppointment(patient)) : null, has("clinical:write") ? button("New clinical note", () => addNote(patient), "primary") : null));
    content.append(profile, scopeNote());
    const tabs = node("div", { class: "tabs", role: "tablist", "aria-label": "Patient sections" });
    const panel = node("section", { role: "tabpanel", id: "patient-panel" });
    const sections = [["history", "Clinic history", () => loadHistory(patient), has("clinical:read")], ["forms", "Assigned forms", () => loadPatientForms(patient), has("forms:fill")], ["billing", "Receipts & balance", () => loadBilling(patient), has("finance:read")], ["documents", "Documents", () => loadDocuments(patient), has("clinical:read")]].filter(item => item[3]);
    for (const [key, label, loader] of sections) {
      const tab = button(label, async () => {
        state.patientTab = key;
        for (const item of tabs.children) { item.setAttribute("aria-selected", "false"); item.tabIndex = -1; }
        tab.setAttribute("aria-selected", "true"); tab.tabIndex = 0; panel.setAttribute("aria-labelledby", tab.id);
        panel.replaceChildren(node("div", { class: "loading" }, "Loading clinic records…"));
        const selectedUnit = state.unitId;
        try { const body = await loader(); if (epoch === state.epoch && selectedUnit === state.unitId && tab.getAttribute("aria-selected") === "true") panel.replaceChildren(body); }
        catch (failure) { if (epoch === state.epoch && tab.getAttribute("aria-selected") === "true") panel.replaceChildren(empty(failure.status === 403 ? "Clinic access is restricted" : "Unable to load records", errorText(failure))); }
      }, "tab-button", { role: "tab", id: `patient-tab-${key}`, "aria-controls": "patient-panel", "aria-selected": "false", tabindex: "-1" }); tabs.append(tab);
    }
    tabs.addEventListener("keydown", event => { if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return; event.preventDefault(); const all = [...tabs.children]; const index = all.indexOf(document.activeElement); const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + all.length) % all.length; all[next].focus(); all[next].click(); });
    content.append(tabs, panel);
    if (sections.length) queueMicrotask(() => ([...tabs.children].find(tab => tab.id === `patient-tab-${state.patientTab}`) || tabs.firstChild).click());
    else panel.replaceChildren(empty("Identity access", "Your clinic permissions allow this shared identity view. Clinical and financial records require separate grants."));
    return content;
  }
  async function loadHistory(patient) {
    const data = await api(`/patients/${encodeURIComponent(patient.id)}/history?${query({ unit_id: state.unitId })}`);
    const notes = list(data.notes).map(note => node("article", { class: "timeline-item" }, node("div", { class: "actions" }, node("h3", {}, note.parent_id ? "Clinical addendum" : note.submission_id ? "Form addendum" : "Clinical note"), badge(note.parent_id || note.submission_id ? "Addendum" : "Finalized", note.parent_id || note.submission_id ? "neutral" : "")), node("p", { class: "timeline-meta" }, `${note.author_name || note.author || "Care team"} · ${unitName()} · ${dateTime(note.created_at)}${note.version ? ` · Version ${note.version}` : ""}`), node("p", { class: "record-text" }, note.text), has("clinical:write") ? button("Add correction", () => addendum("notes", note.id, patient), "text-button") : null));
    const submissions = list(data.submissions).map(submission => node("article", { class: "timeline-item" }, node("div", { class: "actions" }, node("h3", {}, submission.title || submission.form_title || submission.form_snapshot?.title || "Completed form"), badge("Saved snapshot")), node("p", { class: "timeline-meta" }, `${submission.author_name || submission.author || "Care team"} · ${unitName()} · ${dateTime(submission.created_at)} · Version ${formVersion(submission)}`), node("dl", { class: "record-fields" }, Object.entries(submission.answers || {}).map(([key, value]) => node("div", {}, node("dt", {}, list(submission.fields || submission.form_snapshot?.fields).find(f => f.key === key)?.label || key), node("dd", {}, textValue(value))))), has("clinical:write") ? button("Add correction", () => addendum("submissions", submission.id, patient), "text-button") : null));
    return card("Clinic record", "Finalized entries are preserved. Corrections are added to the history.", notes.length || submissions.length ? node("div", { class: "timeline" }, notes, submissions) : empty("No clinical entries in this clinic", "Create a note or complete an assigned form to start this clinic’s record."));
  }
  function addNote(patient) { formDialog("New clinical note", `Patient: ${patient.name} · ${patient.uhid}`, [field("Clinical note", "text", { multiline: true, required: true, maxlength: 12000, class: "full", placeholder: "Record the visit and findings…" })], async (input, form, unit_id) => { await api("/notes", { unit_id, patient_id: patient.id, text: input.text }); closeModal(); state.patientTab = "history"; navigate("patients", patient); notify("Clinical note finalized and added to this clinic’s history."); }, "Finalize note"); }
  function addendum(kind, id, patient) { formDialog("Add a correction", "The original entry stays in the record. Your correction is saved as an addendum.", [field("Correction / addendum", "text", { multiline: true, required: true, maxlength: 12000, class: "full" })], async (input, form, unit_id) => { await api(`/${kind}/${encodeURIComponent(id)}/addenda`, { unit_id, text: input.text }); closeModal(); state.patientTab = "history"; navigate("patients", patient); notify("Addendum saved. The original entry is unchanged."); }, "Save addendum"); }
  async function loadPatientForms(patient) {
    const data = await api(`/forms?${query({ unit_id: state.unitId })}`);
    return card("Assigned forms", "Only versions assigned to the working clinic can be submitted.", table(["Form", "Version", ""], list(data.forms).map(form => [cell(form.title, form.key), badge(`Version ${formVersion(form)}`), button("Fill form →", () => fillForm(form, patient), "secondary button-small")]), "No forms are assigned to this clinic."));
  }
  function fillForm(definition, patient) {
    formDialog(definition.title, `Patient: ${patient.name} · Pinned to version ${formVersion(definition)}`, list(definition.fields).map(item => field(item.label, item.key, { multiline: true, required: item.required, maxlength: 4000, class: "full" })), async (input, form, unit_id) => { await api("/submissions", { unit_id, patient_id: patient.id, form_id: definition.id, answers: input }); closeModal(); state.patientTab = "history"; navigate("patients", patient); notify("Form finalized. This version and its answers remain in the patient history."); }, "Finalize form");
  }
  async function loadBilling(patient) {
    const data = await api(`/receipts?${query({ unit_id: state.unitId, patient_id: patient.id })}`);
    return node("div", {}, node("div", { class: "notice" }, `Clinic balance: ${money(data.balance)} · This clinic’s charges less its non-void payments. Payments are not transferred between clinics.`), card("Receipts", `Issuing clinic: ${unitName()}`, table(["Receipt", "Description", "Charge", "Paid", "Status", ""], list(data.receipts).map(receipt => [cell(receipt.receipt_no || receipt.number || receipt.id, dateTime(receipt.created_at)), receipt.description, money(receipt.charge), money(receipt.paid), badge(receipt.voided_at || receipt.voided ? "Voided" : "Recorded", receipt.voided_at || receipt.voided ? "error" : ""), receipt.voided_at || receipt.voided ? receipt.void_reason || "—" : button("Void", () => voidReceipt(receipt, patient), "danger button-small")]), "No receipts have been issued for this patient at this clinic."), button("+ Issue receipt", () => issueReceipt(patient), "primary")));
  }
  function issueReceipt(patient) { formDialog("Issue clinic receipt", `${patient.name} · A receipt remains attributed to its issuing clinic.`, [field("Description", "description", { required: true, maxlength: 500, class: "full" }), field("Charge (INR)", "charge", { type: "number", min: 0, step: "0.01", value: "0", required: true }), field("Payment received (INR)", "paid", { type: "number", min: 0, step: "0.01", value: "0", required: true })], async (input, form, unit_id) => { const data = await api("/receipts", { unit_id, patient_id: patient.id, description: input.description, charge: Number(input.charge), paid: Number(input.paid) }); closeModal(); navigate("patients", patient); notify(`Receipt ${data.receipt.receipt_no || data.receipt.number || ""} recorded for ${unitName()}.`); }, "Record receipt"); }
  function voidReceipt(receipt, patient) { formDialog("Void receipt", `Receipt ${receipt.receipt_no || receipt.number || ""} is retained with its reason.`, [field("Reason for voiding", "reason", { multiline: true, required: true, maxlength: 1000, class: "full" })], async (input, form, unit_id) => { await api(`/receipts/${encodeURIComponent(receipt.id)}/void`, { unit_id, reason: input.reason }); closeModal(); navigate("patients", patient); notify("Receipt voided with an audit reason. Clinic balance has been recalculated."); }, "Void receipt"); }
  async function appointmentsPage() {
    heading("Appointments", `The clinic diary for ${unitName()}. Shared-doctor availability is checked across clinics.`, has("appointments:write") ? [button("+ Book appointment", () => bookAppointment(), "primary")] : []);
    const data = await api(`/appointments?${query({ unit_id: state.unitId })}`);
    return card("Clinic diary", "All times shown in Asia/Kolkata.", table(["Patient", "Doctor", "When", "Chair", "Clinic"], list(data.appointments).map(item => [cell(item.patient_name || item.name || item.patient_id, item.uhid || ""), item.doctor_name || item.display_name || item.doctor_id, cell(dateTime(item.starts_at), `Until ${dateTime(item.ends_at)}`), item.chair || "—", unitName()]), "No appointments have been booked at this clinic."));
  }
  async function bookAppointment(patient) {
    const scope = state.epoch; const unitId = state.unitId;
    try {
      const data = await api(`/doctors?${query({ unit_id: unitId })}`);
      if (scope !== state.epoch) return;
      if (!list(data.doctors).length) return notify("There are no doctors assigned to this clinic. An access administrator must grant a doctor access before booking.", "warning");
      const fields = [
        ...(patient ? [] : [field("Patient’s exact UHID", "uhid", { required: true, class: "full", placeholder: "Finds the shared organization identity" })]),
        selectField("Doctor", "doctor_id", data.doctors.map(doctor => ({ value: doctor.id, label: doctor.display_name })), data.doctors[0]?.id, { required: true }),
        field("Chair", "chair", { maxlength: 100, placeholder: "e.g. Chair 1" }),
        field("Starts (Asia/Kolkata)", "starts_at", { type: "datetime-local", required: true, value: `${today()}T09:00` }),
        field("Ends (Asia/Kolkata)", "ends_at", { type: "datetime-local", required: true, value: `${today()}T09:30` })
      ];
      formDialog("Book appointment", patient ? `${patient.name} · ${patient.uhid}` : "Select a doctor and patient for the working clinic.", fields, async (input, form, unit_id) => {
        let patientId = patient?.id;
        if (!patientId) {
          const found = await api(`/patients?${query({ uhid: input.uhid.trim() })}`);
          if (found.patients?.length !== 1) throw new Error("No exact patient match. Check the UHID or register the patient first.");
          patientId = found.patients[0].id;
        }
        const starts_at = new Date(`${input.starts_at}:00+05:30`).toISOString();
        const ends_at = new Date(`${input.ends_at}:00+05:30`).toISOString();
        if (ends_at <= starts_at) throw new Error("The end time must be after the start time.");
        await api("/appointments", { unit_id, patient_id: patientId, doctor_id: input.doctor_id, starts_at, ends_at, chair: input.chair || undefined });
        closeModal(); navigate("appointments"); notify("Appointment booked. The doctor’s time is reserved across clinics.");
      }, "Book appointment");
    } catch (failure) { if (scope === state.epoch) notify(errorText(failure), "error"); }
  }
  const formVersion = definition => definition.form_version || "—";
  async function formsPage() {
    const manage = any("forms:manage");
    heading(manage ? "Forms & templates" : "Clinic forms", manage ? "Author once, assign to selected clinics, and preserve each completed version." : `Current forms assigned to ${unitName()}. Open a patient to complete a form.`, manage ? [button("+ Create form", () => authorForm(), "primary")] : []);
    const data = await api(manage ? "/forms" : `/forms?${query({ unit_id: state.unitId })}`);
    return node("div", {}, node("div", { class: "notice" }, "Published versions are immutable. A new version affects new submissions; completed records keep their saved form and answers."), card(manage ? "Organization form library" : "Assigned forms", manage ? "Assignment is independent of clinical access." : "Complete a form from its patient profile.", table(["Form", "Version", "Fields", "Actions"], list(data.forms).map(definition => [cell(definition.title, definition.key), badge(`Version ${formVersion(definition)}`), `${list(definition.fields).length} fields`, node("div", { class: "actions" }, button("Preview", () => previewForm(definition), "secondary button-small"), manage ? button("New version", () => authorForm(definition), "secondary button-small") : null, manage ? button("Assign clinics", () => assignForm(definition), "secondary button-small") : null)]), "No forms are available in this scope.")));
  }
  function previewForm(definition) {
    openModal(definition.title, `Version ${formVersion(definition)} · Read-only preview`, node("div", {}, list(definition.fields).map(item => node("div", { class: "field-editor" }, node("h3", {}, item.label), node("p", { class: "fine-print" }, `${item.key} · ${item.required ? "Required" : "Optional"}`))), node("div", { class: "form-actions" }, button("Close preview", closeModal))));
  }
  function unitCheckboxes(selected = []) {
    return node("fieldset", { class: "full" }, node("legend", {}, "Assign to clinics"), state.units.map(item => node("label", { class: "check-label" }, node("input", { type: "checkbox", name: "unit_ids", value: item.id, checked: selected.includes(item.id) }), item.name)));
  }
  function assignedIds(definition) { return list(definition.unit_ids || definition.assigned_unit_ids || definition.assignments).map(item => typeof item === "string" ? item : item.unit_id); }
  function authorForm(previous) {
    let fieldCounter = 0;
    const fieldsHost = node("div", { class: "full" });
    const selected = previous ? assignedIds(previous) : [];
    function addField(value = {}) {
      const index = ++fieldCounter;
      const row = node("fieldset", { class: "field-editor" }, node("legend", {}, `Field ${index}`), node("div", { class: "form-grid" }, field("Label", `label_${index}`, { required: true, maxlength: 120, value: value.label || "" }), field("Stable key", `key_${index}`, { required: true, maxlength: 40, pattern: "[a-z][a-z0-9_]*", title: "Start with a lowercase letter; use letters, numbers and underscores.", value: value.key || "" })), node("div", { class: "actions" }, node("label", { class: "check-label" }, node("input", { type: "checkbox", name: `required_${index}`, checked: value.required ?? true }), "Required field"), button("Remove field", () => row.remove(), "text-button")));
      row.dataset.fieldIndex = index; fieldsHost.append(row);
    }
    list(previous?.fields).forEach(addField); if (!previous) addField();
    const fields = [field("Form title", "title", { required: true, maxlength: 120, value: previous?.title || "", class: "full" }), field("Form key", "key", { required: true, maxlength: 60, pattern: "[a-z][a-z0-9_-]*", value: previous?.key || "", readonly: !!previous, class: "full" }), fieldsHost, button("+ Add text field", () => addField()), unitCheckboxes(selected)];
    formDialog(previous ? "Publish a new form version" : "Create organization form", previous ? `A new version of ${previous.title}; previous submissions stay unchanged.` : "Add the fields and choose the clinics that can use this form.", fields, async (input, form) => {
      const formFields = [...fieldsHost.children].map(row => { const index = row.dataset.fieldIndex; return { key: input[`key_${index}`].trim(), label: input[`label_${index}`].trim(), required: !!$(`input[name=required_${index}]`, row).checked }; });
      if (!formFields.length || formFields.length > 40) throw new Error("Use between 1 and 40 fields before publishing.");
      if (new Set(formFields.map(item => item.key)).size !== formFields.length) throw new Error("Each field needs a different stable key.");
      const unit_ids = [...form.querySelectorAll("input[name=unit_ids]:checked")].map(input => input.value);
      if (!unit_ids.length) throw new Error("Choose at least one clinic before publishing.");
      await api("/forms", { key: input.key.trim(), title: input.title.trim(), fields: formFields, unit_ids });
      closeModal(); await render(); notify(`Form published and assigned to ${unit_ids.length} ${unit_ids.length === 1 ? "clinic" : "clinics"}.`);
    }, "Publish version", false);
  }
  function assignForm(definition) {
    formDialog("Assign form to clinics", `${definition.title} · Version ${formVersion(definition)}. Removing an assignment blocks new submissions and preserves history.`, [unitCheckboxes(assignedIds(definition))], async (input, form) => {
      const unit_ids = [...form.querySelectorAll("input[name=unit_ids]:checked")].map(item => item.value);
      await api(`/forms/${encodeURIComponent(definition.id)}/assign`, { unit_ids }); closeModal(); await render(); notify("Clinic assignments updated. Saved history is preserved.");
    }, "Save assignments", false);
  }
  const permissionLabels = {
    "patients:read": "Find and view patient identities", "patients:write": "Register and edit patient identities", "appointments:read": "View appointments", "appointments:write": "Book appointments", "clinical:read": "View clinical history", "clinical:write": "Write notes and addenda", "forms:fill": "Complete assigned forms", "finance:read": "View receipts and balances", "finance:write": "Issue and void receipts", "settings:write": "Edit allowed clinic settings"
  };
  const grantTemplates = {
    "custom": [],
    "clinic-admin": ["settings:write", "appointments:read"],
    "doctor": ["patients:read", "patients:write", "appointments:read", "appointments:write", "clinical:read", "clinical:write", "forms:fill"],
    "reception": ["patients:read", "patients:write", "appointments:read", "appointments:write"],
    "accounts": ["patients:read", "finance:read", "finance:write"]
  };
  async function staffPage() {
    heading("People & access", "Explicit clinic permissions. Administration does not grant clinical access.");
    const data = await api("/staff");
    return card("Organization staff", "Review a person’s clinic memberships and replace their scoped grant.", table(["Person", "Organization access", "Clinic memberships", ""], list(data.staff).map(person => [cell(person.display_name, person.username), node("div", { class: "pill-list" }, list(person.permissions).length ? person.permissions.map(permission => badge(permission.replaceAll(":", " · "), "neutral")) : "Clinic permissions only"), node("div", { class: "pill-list" }, list(person.grants).filter(grant => list(grant.permissions).length).map(grant => badge(state.units.find(item => item.id === grant.unit_id)?.name || "Clinic"))), button("Manage clinic access", () => editGrants(person), "secondary button-small")]), "No staff accounts are available."));
  }
  function editGrants(person) {
    const selectedUnit = state.unitId || state.units[0]?.id;
    const permissionHost = node("fieldset", { class: "full" }, node("legend", {}, "Clinic capabilities"), Object.entries(permissionLabels).map(([key, label]) => node("label", { class: "check-label" }, node("input", { type: "checkbox", name: "permissions", value: key }), label)));
    function applyChecks(permissions) { for (const check of permissionHost.querySelectorAll("input")) check.checked = permissions.includes(check.value); }
    const clinicSelect = selectField("Clinic", "unit_id", state.units.map(item => ({ value: item.id, label: item.name })), selectedUnit, { required: true });
    const template = selectField("Apply a starting template", "template", [{ value: "custom", label: "Custom permissions" }, { value: "clinic-admin", label: "Clinic administrator" }, { value: "doctor", label: "Doctor" }, { value: "reception", label: "Reception" }, { value: "accounts", label: "Accounts" }], "custom");
    $("select", template).addEventListener("change", event => { if (event.target.value !== "custom") applyChecks(grantTemplates[event.target.value]); });
    $("select", clinicSelect).addEventListener("change", event => { $("select", template).value = "custom"; applyChecks(list(person.grants).find(grant => grant.unit_id === event.target.value)?.permissions || []); });
    applyChecks(list(person.grants).find(grant => grant.unit_id === selectedUnit)?.permissions || []);
    formDialog("Manage clinic access", `${person.display_name}. Saving replaces this clinic’s grant; no checked capabilities removes its access.`, [clinicSelect, template, permissionHost], async (input, form) => {
      const permissions = [...form.querySelectorAll("input[name=permissions]:checked")].map(item => item.value);
      await api("/grants", { user_id: person.id, unit_id: input.unit_id, permissions }); closeModal(); await render(); notify("Clinic access saved. Changes apply on the person’s next authorized request.");
    }, "Save clinic grant", false);
  }
  const settingLabels = { contact: "Clinic contact", opening_hours: "Opening hours", chairs: "Chairs", doctor_availability: "Doctor availability", fees: "Fees", identity: "Organization identity", forms: "Form definitions", access: "Access policy", catalogue: "Core catalogue" };
  const defaultEditKeys = new Set(["contact", "opening_hours", "chairs", "doctor_availability", "catalogue", "fees"]);
  function settingDisplay(setting) {
    if (setting.key === "fees" && Array.isArray(setting.value)) return node("div", {}, setting.value.map(item => node("div", { class: "summary-line" }, node("span", {}, item.name, node("span", { class: "cell-secondary" }, item.code)), node("strong", {}, money(item.amount)))));
    if (Array.isArray(setting.value)) return node("div", { class: "pill-list" }, setting.value.map(item => badge(textValue(item), "neutral")));
    return node("div", { class: "setting-value" }, textValue(setting.value));
  }
  async function settingsPage() {
    const manage = any("settings:manage");
    const organizationScope = manage && state.settingsScope === "organization";
    heading(organizationScope ? "Organization defaults" : "Clinic settings", organizationScope ? "Set shared values once. Clinics inherit them unless an allowed override is saved." : `Organization defaults and permitted overrides for ${unitName()}.`);
    const tabs = manage ? node("div", { class: "tabs", "aria-label": "Settings scope" }, [["clinic", "Clinic settings"], ["organization", "Organization defaults"]].map(([key, label]) => button(label, () => { state.settingsScope = key; render(); }, "tab-button", { "aria-pressed": state.settingsScope === key ? "true" : "false", class: `tab-button${state.settingsScope === key ? " active" : ""}` }))) : null;
    const data = await api(organizationScope ? "/settings/defaults" : `/settings?${query({ unit_id: state.unitId })}`);
    const rows = list(data.settings).map(setting => {
      const override = setting.source === "override" || setting.source === "unit";
      const editable = organizationScope ? defaultEditKeys.has(setting.key) && !setting.locked : !setting.locked;
      const label = organizationScope && setting.key === "contact" ? "Default contact" : settingLabels[setting.key] || setting.key;
      return node("div", { class: "settings-row" }, node("div", {}, node("h3", {}, label), node("p", {}, organizationScope ? editable ? "Shared across inheriting clinics" : "Managed through its dedicated workflow" : setting.locked ? "Controlled by the organization" : "Local override permitted")), node("div", {}, settingDisplay(setting), badge(organizationScope ? "Organization default" : setting.locked ? "Organization locked" : override ? "Clinic override" : "Inherited", organizationScope || setting.locked ? "neutral" : "")), node("div", { class: "actions" }, editable ? button("Edit", () => editSetting(setting, organizationScope), "secondary button-small") : null, !organizationScope && editable && override ? button("Reset to default", () => resetSetting(setting), "text-button") : null));
    });
    return node("div", {}, tabs, node("div", { class: "notice" }, organizationScope ? "Saving a default updates inheriting clinics. Existing clinic overrides stay in place. Fees and the core catalogue remain organization-controlled; completed records retain their saved values." : "The organization governs forms, core catalogue, fees and access. Clinic contacts, hours, chairs and availability may have local overrides."), card(organizationScope ? "Shared organization values" : "Effective settings", organizationScope ? "Review central values here, then open Clinic settings to see inheritance and overrides." : "Every value shows its source. Resetting an override returns it to the organization default.", node("div", {}, rows)));
  }
  function editSetting(setting, organizationScope = false) {
    if (organizationScope && setting.key === "fees") return editDefaultFees(setting);
    const chairs = setting.key === "chairs";
    const catalogue = setting.key === "catalogue";
    const lines = chairs || catalogue;
    const max = setting.key === "contact" ? 300 : chairs ? 1830 : catalogue ? 12100 : 1500;
    const title = organizationScope && setting.key === "contact" ? "Default contact" : settingLabels[setting.key] || setting.key;
    const detail = organizationScope ? "Changes apply across inheriting clinics. Existing clinic overrides are preserved." : "Save a local override within the organization’s rules.";
    formDialog(`Edit ${title.toLowerCase()}`, chairs ? `Enter one chair name per line. Use between 1 and 30 unique names. ${detail}` : catalogue ? `Enter one catalogue item per line. ${detail}` : detail, [field(chairs ? "Chair names (one per line)" : catalogue ? "Catalogue items (one per line)" : organizationScope ? "Organization default" : "Clinic value", "value", { multiline: true, required: true, maxlength: max, value: lines ? list(setting.value).join("\n") : textValue(setting.value), class: "full" })], async (input, form, unit_id) => {
      const value = lines ? input.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : input.value.trim();
      if (chairs && (value.length < 1 || value.length > 30 || value.some(item => item.length > 60) || new Set(value).size !== value.length)) throw new Error("Use 1–30 unique chair names, each at most 60 characters.");
      if (catalogue && (!value.length || value.length > 100 || value.some(item => item.length > 120) || new Set(value).size !== value.length)) throw new Error("Use 1–100 unique catalogue names, each at most 120 characters.");
      await api(organizationScope ? "/settings/defaults" : "/settings", { ...(organizationScope ? {} : { unit_id }), key: setting.key, value, version: setting.version });
      closeModal(); await render(); notify(organizationScope ? "Organization default saved. Inheriting clinics now use the new value; local overrides are preserved." : "Clinic override saved.");
    }, organizationScope ? "Save organization default" : "Save override", !organizationScope);
  }
  function editDefaultFees(setting) {
    let counter = 0;
    const rows = node("div", { class: "full" });
    function addFee(fee = {}) {
      const index = ++counter;
      const row = node("fieldset", { class: "field-editor" }, node("legend", {}, "Service fee"), node("div", { class: "form-grid" }, field("Service code", `code_${index}`, { value: fee.code || "", required: true, maxlength: 40 }), field("Service name", `name_${index}`, { value: fee.name || "", required: true, maxlength: 120 }), field("Fee (INR)", `amount_${index}`, { type: "number", value: fee.amount ?? "", min: "0", max: "9999999", step: "0.01", required: true })), button("Remove fee", () => row.remove(), "text-button"));
      row.dataset.feeIndex = index; rows.append(row);
    }
    list(setting.value).forEach(addFee); if (!rows.children.length) addFee();
    formDialog("Edit organization fees", "Fees are shared and cannot be overridden by clinics. Existing clinical and financial records keep their saved values.", [rows, button("+ Add service fee", () => addFee())], async (input, form) => {
      const value = [...rows.children].map(row => { const index = row.dataset.feeIndex; return { code: input[`code_${index}`].trim(), name: input[`name_${index}`].trim(), amount: Number(input[`amount_${index}`]) }; });
      if (!value.length || value.length > 100) throw new Error("Use between 1 and 100 service fees.");
      if (new Set(value.map(item => item.code)).size !== value.length) throw new Error("Each service fee needs a unique code.");
      if (value.some(item => !Number.isFinite(item.amount) || item.amount < 0 || Math.abs(item.amount * 100 - Math.round(item.amount * 100)) > 0.00001)) throw new Error("Fees must be nonnegative INR amounts with up to two decimal places.");
      await api("/settings/defaults", { key: "fees", value, version: setting.version }); closeModal(); await render(); notify("Organization fees saved. Existing records retain their original amounts.");
    }, "Save organization fees", false);
  }
  function resetSetting(setting) {
    formDialog("Reset to organization default", `${settingLabels[setting.key] || setting.key}: this clinic’s local override will be removed.`, [], async (input, form, unit_id) => { await api("/settings/reset", { unit_id, key: setting.key, version: setting.version }); closeModal(); await render(); notify("Local override removed. This clinic now inherits the organization default."); }, "Reset to default");
  }
  async function auditPage() {
    heading("Activity log", "Accountable changes across this organization, without clinical payloads.");
    const data = await api("/audit");
    return card("Recent activity", "Safe action metadata is retained by the organization.", table(["When", "Action", "Actor", "Clinic", "Reference"], list(data.events).map(event => [dateTime(event.created_at || event.happened_at), cell(String(event.action || "Action").replaceAll(".", " · ").replaceAll("_", " ")), event.actor || event.actor_name || event.username || event.actor_id || "—", state.units.find(item => item.id === event.unit_id)?.name || (event.unit_id ? "Clinic" : "Organization"), node("span", { class: "code-label" }, event.subject_id || "—")]), "No activity has been recorded yet."));
  }
  async function loadDocuments(patient) {
    const data = await api(`/documents?${query({ unit_id: state.unitId, patient_id: patient.id })}`);
    const rows = list(data.documents).map(item => [cell(item.filename, dateTime(item.created_at)), item.mime, `${Math.max(1, Math.ceil(Number(item.bytes) / 1024))} KB`, node("a", { href: `${ROOT}/documents/${encodeURIComponent(item.id)}/download?${query({ unit_id: state.unitId })}`, download: item.filename, class: "secondary button-small" }, "Download")]);
    return card("Patient documents", "Fictional files stored in this organization’s local document space. Up to 1 MiB per file.", table(["File", "Type", "Size", ""], rows, "No documents are stored for this patient at this clinic."), has("clinical:write") ? button("+ Upload document", () => uploadDocument(patient), "primary") : null);
  }
  function uploadDocument(patient) {
    formDialog("Upload fictional document", `${patient.name} · Text, PDF, PNG or JPEG · Maximum 1 MiB`, [field("Choose a fictional file", "file", { type: "file", accept: ".txt,.pdf,.png,.jpg,.jpeg,text/plain,application/pdf,image/png,image/jpeg", required: true, class: "full" })], async (input, form, unit_id) => {
      const file = $("input[type=file]", form).files[0];
      if (!file || file.size < 1 || file.size > 1024 * 1024) throw new Error("Choose a nonempty file up to 1 MiB.");
      const mime = file.type || ({ txt: "text/plain", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" }[file.name.split(".").pop().toLowerCase()]);
      if (!["text/plain", "application/pdf", "image/png", "image/jpeg"].includes(mime)) throw new Error("Choose a text, PDF, PNG or JPEG file.");
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("The file could not be read. Please choose it again.")); reader.readAsDataURL(file); });
      await api("/documents", { unit_id, patient_id: patient.id, filename: file.name, mime, base64 });
      closeModal(); state.patientTab = "documents"; navigate("patients", patient); notify("Document uploaded to this clinic’s patient record.");
    }, "Upload document");
  }
  async function boot() {
    try {
      const identity = await api("", undefined, { quiet: true }); state.organization = identity.organization;
      if (state.organization?.name) { document.title = `${state.organization.name} · Practice workspace`; $("#login-title").textContent = `Sign in to ${state.organization.name}`; }
      try { await startSession(await api("/api/v1/auth/me", undefined, { quiet: true })); }
      catch (failure) { if (failure.status !== 401) throw failure; showLogin(); }
    } catch (failure) { $("#login-error").textContent = errorText(failure); $("#login-error").hidden = false; }
  }
  boot();
})();
