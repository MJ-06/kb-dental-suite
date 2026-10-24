// Files the panel patients already in the CRM under their panel.
//
// Registration has asked private-or-panel for a while, and the CRM files a
// panel patient under their panel as a company -- that is what separates the
// CGHS and DGEHS patients from the cash patients instead of showing every one
// of them as "Individual". But the queue that carries a newly registered
// patient into the CRM left the company blank, so every patient registered
// between that queue arriving and the fix landed with none.
//
// It reads the panel from the REGISTER, by the contact's UHID, not from the
// contact record. The contacts were created by the first import, before the
// panel fields were carried across, and an import SKIPS a contact it already
// has -- so almost every one of them has a blank panel cell however many
// times Import Patients is run. The register is where the answer actually is.
//
// Nothing is guessed and no patient's panel is invented: a patient the
// register does not put on a panel is left alone. Both books are read, so
// patients registered in the empanelled book count. The panel is written onto
// the contact as well, so it stops being a lookup next time.
//
// Rows it will not touch:
//   - a contact already filed under a company, whatever that company is
//   - a contact with no panel on it: a private patient belongs under no
//     company, and that is what makes the split mean anything
// Only the one cell per contact is written. Nothing else in the row is
// rewritten, so a name, a number or a UHID cannot be disturbed.
//
// CLOSE THE CRM SCREEN BEFORE RUNNING THIS. The CRM saves a list by writing
// its whole copy back over the tab, so a CRM left open could overwrite what
// this does with what it had in memory before.
//
// WHERE: the MAIN PMS book's Apps Script project, as a new script file.
// HOW:   Run reportPanelCompanies first -- it only reads, and prints exactly
//        what would change. Then set CONFIRM to "YES" and run
//        backfillPanelCompanies. Set CONFIRM back to "" afterwards.

var CONFIRM = "";

function pcSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

// A tab of CRM records as {header: value} plus the row it came from.
function pcRead_(name) {
  var sh = pcSheet_(name);
  if (!sh || sh.getLastRow() < 2) return { sheet: sh, headers: [], rows: [] };
  var data = sh.getDataRange().getValues();
  var headers = data[0].map(String);
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var rec = { __row: i + 1 };
    var any = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      rec[headers[c]] = data[i][c];
      if (String(data[i][c] || "").trim()) any = true;
    }
    if (any) rows.push(rec);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

// What the register says each patient's panel is, by UHID.
//
// regAllRows_ and findRegColumn_ come from Code.gs in this same project, so
// both books are read exactly the way the app reads them. Run somewhere
// without them, it says so rather than quietly finding no panels.
function pcPanelsFromRegister_() {
  if (typeof regAllRows_ !== "function" || typeof findRegColumn_ !== "function") {
    return { error: "Paste this beside Code.gs in the same Apps Script project — it reads the register through it." };
  }
  var data = regAllRows_();
  if (!data || data.length <= 1) return { byUhid: {}, rows: 0, onPanel: 0 };
  var h = data[0];
  var uhidCol = findRegColumn_(h, ["UHID", "Registration ID"]);
  var panelCol = findRegColumn_(h, ["Panel"]);
  var catCol = findRegColumn_(h, ["Panel Category"]);
  var cardCol = findRegColumn_(h, ["Card ID"]);
  if (uhidCol < 0) return { error: "No UHID column on the register." };
  if (panelCol < 0) return { byUhid: {}, rows: data.length - 1, onPanel: 0, noPanelColumn: true };

  var byUhid = {}, onPanel = 0;
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][uhidCol] || "").trim().toUpperCase();
    if (!id) continue;
    var panel = String(data[i][panelCol] || "").trim();
    // A patient re-registered after a gap has several rows. Any row naming a
    // panel is taken: a blank on a later row is somebody not filling the
    // field in again, not the patient leaving the panel.
    if (!panel) continue;
    if (!byUhid[id]) onPanel++;
    byUhid[id] = {
      panel: panel,
      category: catCol >= 0 ? String(data[i][catCol] || "").trim() : "",
      cardId: cardCol >= 0 ? String(data[i][cardCol] || "").trim() : ""
    };
  }
  return { byUhid: byUhid, rows: data.length - 1, onPanel: onPanel };
}

function pcName_(c) {
  var n = (String(c.firstName || "").trim() + " " + String(c.lastName || "").trim()).trim();
  return n || String(c.uhid || "").trim() || "(no name)";
}

// Everything both functions have to agree on, worked out once.
function pcPlan_() {
  var contacts = pcRead_("CRM Contacts");
  if (!contacts.sheet) return { error: "No CRM Contacts tab in this book. Open the CRM once first." };
  if (!contacts.rows.length) return { error: "There are no contacts in the CRM yet." };

  var reg = pcPanelsFromRegister_();
  if (reg.error) return { error: reg.error };

  var companies = pcRead_("CRM Companies");
  var byName = {};
  companies.rows.forEach(function (co) {
    var k = String(co.name || "").trim().toUpperCase();
    if (k) byName[k] = String(co.id || "").trim();
  });

  var plan = {
    contacts: contacts, companies: companies, byName: byName, reg: reg,
    total: contacts.rows.length,
    toFile: [],        // contacts that will get a company
    newPanels: [],     // panels the CRM has no company for yet
    alreadyFiled: 0, private: 0, noUhid: 0
  };

  var wanted = {};
  contacts.rows.forEach(function (c) {
    if (String(c.companyId || "").trim()) { plan.alreadyFiled++; return; }
    var uhid = String(c.uhid || "").trim().toUpperCase();
    // The contact's own panel cell first -- a contact added since the fix
    // carries it -- then the register, which is where the answer is for
    // everybody added before.
    var onContact = String(c.panel || "").trim();
    var fromReg = uhid ? reg.byUhid[uhid] : null;
    var panel = onContact || (fromReg ? fromReg.panel : "");
    if (!panel) {
      if (!uhid) plan.noUhid++; else plan.private++;
      return;
    }
    plan.toFile.push({
      row: c.__row, name: pcName_(c), uhid: String(c.uhid || "").trim(), panel: panel,
      category: onContact ? String(c.panelCategory || "") : (fromReg ? fromReg.category : ""),
      cardId: onContact ? String(c.cardId || "") : (fromReg ? fromReg.cardId : ""),
      fromRegister: !onContact
    });
    var key = panel.toUpperCase();
    if (!byName[key] && !wanted[key]) { wanted[key] = panel; plan.newPanels.push(panel); }
  });
  return plan;
}

function reportPanelCompanies() {
  var p = pcPlan_();
  if (p.error) { Logger.log(p.error); return; }

  Logger.log("Register rows read (both books):      %s", p.reg.rows);
  Logger.log("Patients the register puts on a panel: %s", p.reg.onPanel || 0);
  if (p.reg.noPanelColumn) Logger.log("  (the register has no Panel column at all)");
  Logger.log("");
  Logger.log("Contacts in the CRM:              %s", p.total);
  Logger.log("Already filed under a company:    %s", p.alreadyFiled);
  Logger.log("Private — no panel, left alone:   %s", p.private);
  if (p.noUhid) Logger.log("No UHID, so nothing to look up:   %s", p.noUhid);
  Logger.log("On a panel but filed nowhere:     %s", p.toFile.length);
  Logger.log("");

  if (!p.toFile.length) {
    Logger.log("Nothing to do — every panel patient is already filed under their panel.");
    return;
  }

  var byPanel = {};
  p.toFile.forEach(function (t) {
    if (!byPanel[t.panel]) byPanel[t.panel] = [];
    byPanel[t.panel].push(t);
  });
  Object.keys(byPanel).forEach(function (panel) {
    var isNew = p.newPanels.indexOf(panel) >= 0;
    Logger.log("%s — %s patient(s)%s", panel, byPanel[panel].length,
               isNew ? "  (no company for this panel yet — one would be made)" : "");
    byPanel[panel].slice(0, 20).forEach(function (t) {
      Logger.log("    row %s  %s  %s%s", t.row, t.uhid || "—", t.name,
                 t.fromRegister ? "   (panel read from the register)" : "");
    });
    if (byPanel[panel].length > 20) Logger.log("    … and %s more", byPanel[panel].length - 20);
  });

  Logger.log("");
  Logger.log("Nothing has been changed. To file those %s patient(s): CLOSE THE CRM", p.toFile.length);
  Logger.log('SCREEN, set CONFIRM = "YES" at the top of this file, and run');
  Logger.log("backfillPanelCompanies.");
}

function backfillPanelCompanies() {
  var p = pcPlan_();
  if (p.error) { Logger.log(p.error); return; }

  if (String(CONFIRM).trim().toUpperCase() !== "YES") {
    Logger.log("Nothing was changed — CONFIRM is not set.");
    Logger.log("");
    Logger.log('Run reportPanelCompanies first, then set CONFIRM = "YES" and run again.');
    return;
  }
  if (!p.toFile.length) {
    Logger.log("Nothing to do — every panel patient is already filed under their panel.");
    return;
  }

  // The companies first, so no contact is ever pointed at one that does not
  // exist. A run that stops between the two leaves contacts unfiled, which
  // this can simply be run again to finish -- the other order would leave
  // contacts pointing at nothing.
  var made = 0;
  if (p.newPanels.length) {
    var csh = p.companies.sheet;
    var headers = p.companies.headers.slice();
    if (!csh) {
      csh = SpreadsheetApp.getActiveSpreadsheet().insertSheet("CRM Companies");
      headers = ["id", "name", "industry", "createdAt"];
      csh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else if (!headers.length) {
      headers = ["id", "name", "industry", "createdAt"];
      csh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    var now = new Date().toISOString();
    p.newPanels.forEach(function (panel) {
      // The CRM's own id shape, so these are indistinguishable from the ones
      // it makes itself.
      var id = "c" + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 5);
      var rec = { id: id, name: panel, industry: "Panel", createdAt: now };
      csh.appendRow(headers.map(function (h) { return rec[h] === undefined ? "" : rec[h]; }));
      p.byName[panel.toUpperCase()] = id;
      made++;
    });
    SpreadsheetApp.flush();
  }

  // Then the contacts. One cell each -- the company they belong under.
  var col = p.contacts.headers.indexOf("companyId");
  if (col < 0) {
    // No contact has ever carried one, so the column is not there to write to.
    col = p.contacts.headers.length;
    p.contacts.sheet.getRange(1, col + 1).setValue("companyId");
    Logger.log("Added a companyId column to CRM Contacts.");
  }

  // The panel itself goes onto the contact as well, so the register is no
  // longer the only thing that knows and the CRM can group on it directly.
  function pcCol_(name) {
    var at = p.contacts.headers.indexOf(name);
    if (at >= 0) return at;
    at = p.contacts.headers.length;
    p.contacts.headers.push(name);
    p.contacts.sheet.getRange(1, at + 1).setValue(name);
    return at;
  }
  var panelCol = pcCol_("panel");
  var catCol = pcCol_("panelCategory");
  var cardCol = pcCol_("cardId");

  var filed = 0, missing = 0;
  p.toFile.forEach(function (t) {
    var id = p.byName[t.panel.toUpperCase()];
    if (!id) { missing++; return; }
    p.contacts.sheet.getRange(t.row, col + 1).setValue(id);
    if (t.fromRegister) {
      p.contacts.sheet.getRange(t.row, panelCol + 1).setValue(t.panel);
      if (t.category) p.contacts.sheet.getRange(t.row, catCol + 1).setValue(t.category);
      if (t.cardId) p.contacts.sheet.getRange(t.row, cardCol + 1).setValue(t.cardId);
    }
    filed++;
  });
  SpreadsheetApp.flush();

  Logger.log("Filed %s patient(s) under their panel.", filed);
  if (made) Logger.log("Made %s panel company(ies): %s", made, p.newPanels.join(", "));
  if (missing) Logger.log("%s could not be filed — their panel had no company and none could be made.", missing);
  Logger.log("%s were already filed and %s are private, both left alone.", p.alreadyFiled, p.private);
  Logger.log("");
  Logger.log("Then:");
  Logger.log('  - Set CONFIRM back to "" so this cannot run again by accident');
  Logger.log("  - Reopen the CRM and check Contacts: the panel patients should show");
  Logger.log("    their panel under Company instead of Individual");
}
