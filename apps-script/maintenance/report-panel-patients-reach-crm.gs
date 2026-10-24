// Why the empanelled book's patients are, or are not, reaching the CRM.
//
// The CRM asks the app for everybody the clinic has registered, and the app
// is meant to read BOTH books -- the main one and the empanelled one -- and
// hand them over together. The clinic says the CGHS patients never arrive.
//
// Rather than reason about it, this follows the exact path the CRM's Import
// Patients takes and prints what comes back at each step: which books were
// opened, how many rows each holds, whether the merged table has a Panel
// column, how many rows fill it in, and finally what getAllPatients -- the
// one the CRM actually calls -- says about them.
//
// Wherever the panel patients disappear, the step before it will still show
// them and the step after will not.
//
// It only reads. Nothing is written, moved or changed.
//
// WHERE: the MAIN PMS book's Apps Script project, beside Code.gs.
// HOW:   pick reportPanelPatientsReachCrm and press Run.

function reportPanelPatientsReachCrm() {
  if (typeof regSheets_ !== "function" || typeof regAllRows_ !== "function") {
    Logger.log("Paste this beside Code.gs in the same project — it uses the app's own readers.");
    return;
  }

  // ── 1. which books the app opens ───────────────────────────────────────
  Logger.log("1. THE BOOKS THE APP READS");
  Logger.log("   This book:  %s", SpreadsheetApp.getActiveSpreadsheet().getName());
  Logger.log("   Its id:     %s", SS_ID);
  Logger.log("   Panel book: %s", PANEL_PMS_SHEET_ID);
  Logger.log("   Same book?  %s", SS_ID === PANEL_PMS_SHEET_ID ? "YES — only one book will be read" : "no");

  var sheets;
  try {
    sheets = regSheets_();
  } catch (e) {
    Logger.log("   regSheets_ threw: %s", e.message);
    return;
  }
  Logger.log("   Registration sheets opened: %s", sheets.length);
  for (var i = 0; i < sheets.length; i++) {
    var ss = sheets[i].getParent();
    Logger.log("     [%s] %s  —  in \"%s\"  —  %s row(s)",
               i, sheets[i].getName(), ss.getName(), Math.max(0, sheets[i].getLastRow() - 1));
  }
  if (sheets.length < 2) {
    Logger.log("");
    Logger.log("   >> ONLY ONE SHEET. The empanelled book was not opened. If this book");
    Logger.log("      is the main one, openById failed — check the execution log above");
    Logger.log("      for \"Panel book unreachable\", and that this account can open it.");
  }

  // Read the panel book directly too, so its own count is known whatever the
  // app managed.
  Logger.log("");
  Logger.log("2. THE EMPANELLED BOOK, READ DIRECTLY");
  var panelRows = 0, panelWithPanel = 0, panelExamples = [];
  try {
    var psh = SpreadsheetApp.openById(PANEL_PMS_SHEET_ID).getSheetByName("Registrations");
    if (!psh) {
      Logger.log("   It has no Registrations tab.");
    } else {
      var pdata = psh.getDataRange().getValues();
      panelRows = Math.max(0, pdata.length - 1);
      Logger.log("   Rows: %s", panelRows);
      Logger.log("   Its headings: %s", pdata.length ? pdata[0].join(" | ") : "(none)");
      var pPanel = pdata.length ? findRegColumn_(pdata[0], ["Panel"]) : -1;
      var pUhid = pdata.length ? findRegColumn_(pdata[0], ["UHID", "Registration ID"]) : -1;
      var pName = pdata.length ? findRegColumn_(pdata[0], ["Full Name", "Name"]) : -1;
      Logger.log("   Panel column at: %s   UHID column at: %s", pPanel, pUhid);
      for (var r = 1; r < pdata.length; r++) {
        var v = pPanel >= 0 ? String(pdata[r][pPanel] || "").trim() : "";
        if (!v) continue;
        panelWithPanel++;
        if (panelExamples.length < 10) {
          panelExamples.push((pUhid >= 0 ? String(pdata[r][pUhid] || "").trim() : "?") + "  " +
                             (pName >= 0 ? String(pdata[r][pName] || "").trim() : "?") + "  —  " + v);
        }
      }
      Logger.log("   Rows naming a panel: %s", panelWithPanel);
      panelExamples.forEach(function (x) { Logger.log("     %s", x); });
    }
  } catch (e2) {
    Logger.log("   COULD NOT OPEN IT: %s", e2.message);
    Logger.log("   >> This is the fault. The app cannot reach the empanelled book, so");
    Logger.log("      its patients can never reach the CRM.");
  }

  // ── 3. the merged table the app builds ─────────────────────────────────
  Logger.log("");
  Logger.log("3. THE TWO BOOKS MERGED, AS THE APP MERGES THEM");
  var data = regAllRows_();
  Logger.log("   Rows: %s", Math.max(0, data.length - 1));
  if (data.length < 2) { Logger.log("   Empty — nothing further to check."); return; }
  var mPanel = findRegColumn_(data[0], ["Panel"]);
  Logger.log("   Panel column at: %s%s", mPanel, mPanel < 0 ? "   >> MISSING: no row can carry a panel" : "");
  var mergedWithPanel = 0;
  if (mPanel >= 0) {
    for (var r2 = 1; r2 < data.length; r2++) {
      if (String(data[r2][mPanel] || "").trim()) mergedWithPanel++;
    }
  }
  Logger.log("   Rows naming a panel: %s", mergedWithPanel);
  if (panelWithPanel && !mergedWithPanel) {
    Logger.log("   >> THE PANEL IS LOST IN THE MERGE. The empanelled book has %s such", panelWithPanel);
    Logger.log("      row(s) but the merged table has none.");
  }

  // ── 4. what the CRM is actually handed ─────────────────────────────────
  Logger.log("");
  Logger.log("4. WHAT getAllPatients HANDS THE CRM  (what Import Patients uses)");
  var res = getAllPatients({ includeArchive: "true" });
  var list = (res && res.patients) || [];
  Logger.log("   Patients returned: %s", list.length);
  var withPanel = list.filter(function (q) { return String(q.panel || "").trim(); });
  Logger.log("   With a panel:      %s", withPanel.length);
  withPanel.slice(0, 10).forEach(function (q) {
    Logger.log("     %s  %s  —  %s", q.uhid, q.name, q.panel);
  });

  // ── the verdict ────────────────────────────────────────────────────────
  Logger.log("");
  Logger.log("WHERE IT STANDS");
  if (!panelWithPanel) {
    Logger.log("  The empanelled book itself has no row naming a panel. Nothing is");
    Logger.log("  being dropped — there is nothing there yet to carry across.");
  } else if (!withPanel.length) {
    Logger.log("  The empanelled book has %s panel patient(s) and the CRM is handed", panelWithPanel);
    Logger.log("  none. Step 1 or 3 above says which step loses them.");
  } else if (withPanel.length < panelWithPanel) {
    Logger.log("  %s of %s panel patient(s) reach the CRM. Some are being dropped.",
               withPanel.length, panelWithPanel);
  } else {
    Logger.log("  All %s panel patient(s) reach the CRM. If they still show as", withPanel.length);
    Logger.log("  \"Individual\", the fault is in the import rather than the read —");
    Logger.log("  run Import Patients again now and they should be filed.");
  }
}
