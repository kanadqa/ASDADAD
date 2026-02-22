/**
 * FINAL SYSTEM (NO COUNTERPARTIES, MANUAL MONEY STATUS)
 * Истина: ЛИСТ МЕНЕДЖЕРА
 * БД: только распределение строк между менеджерами
 *
 * + Умеет строить modern (титул=1, шапка=2, данные=3) и legacy (шапка=1, данные=2)
 *
 * ВАЖНО (ЖЕЛЕЗНО):
 * - "Дата баланса" и "Обновлено" НЕ должны меняться из-за скриптовых перерисовок/выгрузок/синхронизаций.
 * - В БД никакая автоматика дат НЕ работает (ни onEdit, ни snapshot).
 *
 * Автор: Khan (адаптировано/починено)
 */

/* ================= CONFIG ================= */

const CFG = {
  DB: "БД",

  MANAGER_SHEETS: ["Alpha", "Giba", "Marcus", "Nitish", "Jacob", "Viza", "Hanare Ro", "xssyao"],

  STATUSES: ["● Активно", "◐ Пауза", "⛔ Заблокировано", "⚠ Проблема", "○ Закрыто"],
  HIDE_FROM_MANAGERS_STATUSES: ["○ Закрыто", "⛔ Заблокировано"],

  PROJECTS: [
    "1xBet","4rabet","Batery.in","1win.pro","Melbet.com","Cwinz","Rajbets.com",
    "Pin-up.bet","Odds96","Lopebet","Bluechip.io","BC.game","Oppa888.com","22bet",
    "Glory.bet","Crickex.com","9winz.com","Paripulse","Vbet10","Megapari","Mostbet",
    "12bet.com","piratespot1.com","chillbet.net","Shareus","Binany","Maxi",
    "Spinbetter","Lucky-star","Bettilt","Valor.bet","Easy-X Casino","Нет проекта",
    "1xslots","Betandyou","Betwinner","DBbet","Bilbet"
  ],

  RATINGS: ["⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐"],
  MONEY_FLOW_STATUSES: ["🟦 Отыгрывается","🟧 Выводится","🛑 Проиграно"],

  DB_HEADERS: [
    "ID","Менеджер","Контрагент","Самообработка","Проект","Логин","Пароль","Ссылка",
    "Баланс","Дата баланса","Статус","Заметка",
    "Отправлено","Готово к выводу","На выводе",
    "Статус денег","Обновлено","Оценка контрагента"
  ],

  CREATOR_NICK: "Khan",

  SEPARATOR_ROWS: 1,
  PRETTY_ROWS_LIMIT: 1000,

  BALANCE_DATETIME_FORMAT: "dd.MM.yyyy HH:mm:ss",

  COL_WIDTHS: [
    100,140,190,120,135,190,130,170,105,145,
    150,165,140,140,140,150,185,190
  ],

  // сколько секунд "глушим" snapshot-ремонтёр после любой скриптовой перерисовки
  TS_MUTE_SECONDS: 120
};

/* ================= LAYOUT MODES =================
   modern: титул(1), шапка(2), данные(3)
   legacy: шапка(1), данные(2), без титула
*/

const LAYOUTS = {
  modern: { mode: "modern", useTitle: true,  titleRow: 1, headerRow: 2, startRow: 3, freezeRows: 2, freezeCols: 4 },
  legacy: { mode: "legacy", useTitle: false, titleRow: null, headerRow: 1, startRow: 2, freezeRows: 1, freezeCols: 4 }
};

const LAYOUT_PROP_KEY = "SYS_LAYOUT_MODE";
let __LAYOUT_CACHE = null;

function getLayout_() {
  if (__LAYOUT_CACHE) return __LAYOUT_CACHE;
  const props = PropertiesService.getDocumentProperties();
  const mode = String(props.getProperty(LAYOUT_PROP_KEY) || "modern").trim();
  __LAYOUT_CACHE = (mode === "legacy") ? LAYOUTS.legacy : LAYOUTS.modern;
  return __LAYOUT_CACHE;
}

function setLayoutMode_(mode) {
  const m = (mode === "legacy") ? "legacy" : "modern";
  PropertiesService.getDocumentProperties().setProperty(LAYOUT_PROP_KEY, m);
  __LAYOUT_CACHE = null;
}

function headerRow_() { return getLayout_().headerRow; }
function startRow_()  { return getLayout_().startRow;  }
function useTitle_()  { return getLayout_().useTitle;  }

/* ================= COLUMN MAP ================= */

const COL0 = (() => {
  const m = {};
  CFG.DB_HEADERS.forEach((h, i) => (m[h] = i));
  return m;
})();

function idx0_(name) {
  const i = COL0[name];
  if (i === undefined) throw new Error(`Не найдена колонка в CFG.DB_HEADERS: "${name}"`);
  return i;
}
function idx1_(name) { return idx0_(name) + 1; }

/* ================= STABILITY HELPERS (RETRY) ================= */

function isTransientSpreadsheetError_(e) {
  const m = String((e && e.message) ? e.message : e).toLowerCase();
  return (
    m.includes("слишком долго") ||
    m.includes("cannot get access") ||
    m.includes("try again") ||
    m.includes("timed out") ||
    m.includes("service spreadsheets")
  );
}

function withSpreadsheetRetry_(fn, tries) {
  const max = tries || 5;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientSpreadsheetError_(e) || i === max - 1) throw e;
      Utilities.sleep(400 * Math.pow(2, i)); // 400ms, 800ms, 1600ms...
    }
  }
  throw lastErr;
}

/* ================= TIMESTAMP MUTING (IRONCLAD) ================= */

const TS_MUTE_UNTIL_KEY = "SYS_TS_MUTE_UNTIL_MS";

/**
 * Вызываем перед/во время любых скриптовых перерисовок/выгрузок.
 * Snapshot-ремонтёр увидит это и НЕ будет менять даты.
 */
function muteTimestampRepair_(seconds) {
  const sec = Number(seconds || CFG.TS_MUTE_SECONDS || 120);
  const until = Date.now() + Math.max(10, sec) * 1000;
  PropertiesService.getDocumentProperties().setProperty(TS_MUTE_UNTIL_KEY, String(until));
}

function isTimestampRepairMuted_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(TS_MUTE_UNTIL_KEY);
  const until = Number(raw || "0");
  return Date.now() < until;
}

/* ================= MENU ================= */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🧩 Система БД")
    .addItem("АДМИН: Построить систему (АКТУАЛЬНЫЙ формат)", "adminBuildSystemModern")
    .addItem("АДМИН: Построить систему (СТАРЫЙ формат)", "adminBuildSystemLegacy")
    .addSeparator()
    .addItem("Менеджер: Отправить данные в БД + перерисовать лист", "managerRefreshMyData")
    .addSeparator()
    .addItem("АДМИН: Отправить данные в БД всех менеджеров", "adminCollectAllManagers")
    .addSeparator()
    .addItem("АДМИН: Защитить ID", "protectIdColumns_")
    .addItem("АДМИН: Включить ремонтёр snapshot", "setupSnapshotRepairTrigger_")
    .addSeparator()
    .addItem("АДМИН: Проставить ID пустым строкам в БД", "adminFillMissingIdsInDB")
    .addItem("АДМИН: Восстановить формат текущего листа", "adminRestoreFormatActiveSheet")
    .addItem("АДМИН: Выгрузить БД → листы (ВСЕ строки)", "adminExportDBToAllManagers")
    .addToUi();
}

/* ================= ADMIN BUILD SYSTEM ================= */

function adminBuildSystemModern() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    setLayoutMode_("modern");
    withSpreadsheetRetry_(() => buildSystem_(ss), 5);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function adminBuildSystemLegacy() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    setLayoutMode_("legacy");
    withSpreadsheetRetry_(() => buildSystem_(ss), 5);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function buildSystem_(ss) {
  const layout = getLayout_();

  // на время построения/массовых записей "глушим" snapshot
  muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

  ensureDB_(ss);
  buildManagerSheets_(ss);

  const db = getSheetOrThrow_(ss, CFG.DB);
  if (db.getLastRow() < startRow_()) {
    insertSampleData_(db);
  }

  CFG.MANAGER_SHEETS.forEach(name => {
    withSpreadsheetRetry_(() => refreshManagerSheet_(ss, name), 4);
  });

  SpreadsheetApp.getUi().alert(
    `Готово ✅
Формат: ${layout.mode}
` +
    `DB: headerRow=${layout.headerRow}, startRow=${layout.startRow}

` +
    `Дальше: открой лист менеджера и работай через меню.`
  );
}

/* ================= HELPERS ================= */

function getSheetOrThrow_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Лист не найден: "${name}"`);
  return sh;
}

function isManagerSheetName_(name) {
  return CFG.MANAGER_SHEETS.includes(name);
}

function removeAllBandings_(sh) {
  sh.getBandings().forEach(b => b.remove());
}

function columnToLetter_(column) {
  let temp = "", letter = "";
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

function applyColumnWidths_(sh) {
  CFG.COL_WIDTHS.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function trimExtraColumns_(sh, requiredCols) {
  const need = Number(requiredCols || CFG.DB_HEADERS.length);
  const max = sh.getMaxColumns();
  if (max > need) {
    sh.deleteColumns(need + 1, max - need);
  }
}

function applyStandardFormats_(sh, startRow, rowCount) {
  if (!rowCount || rowCount <= 0) return;

  sh.getRange(startRow, idx1_("Баланс"), rowCount, 1).setNumberFormat("#,##0.00");
  sh.getRange(startRow, idx1_("Дата баланса"), rowCount, 1).setNumberFormat(CFG.BALANCE_DATETIME_FORMAT);
  sh.getRange(startRow, idx1_("Отправлено"), rowCount, 3).setNumberFormat("#,##0.00");
  sh.getRange(startRow, idx1_("Обновлено"), rowCount, 1).setNumberFormat("dd.MM.yyyy HH:mm:ss");
}

/* ================= TITLE ROW (MODERN ONLY) =================
   Делаем НЕ броско, но заметно: светлый фон, серый текст, слева.
*/

function applyTitleRow_(sh) {
  if (!useTitle_()) return; // legacy: без титула

  const lastCol = CFG.DB_HEADERS.length;
  const title = "Система БД • by " + CFG.CREATOR_NICK;

  // 1) Снимаем любые старые merge в первой строке и чистим контент
  const full = sh.getRange(1, 1, 1, lastCol);
  try { full.breakApart(); } catch (e) {}
  full.clearContent();

  // 2) Находим первую ВИДИМУЮ колонку (на менеджер-листах это будет C, т.к. A и B скрыты)
  let startCol = 1;
  for (let c = 1; c <= lastCol; c++) {
    let hidden = false;
    try { hidden = sh.isColumnHiddenByUser(c) || sh.isColumnHiddenByFilter(c); } catch (e) {
      // если isColumnHiddenByFilter недоступен — игнорим
      hidden = sh.isColumnHiddenByUser(c);
    }
    if (!hidden) { startCol = c; break; }
  }

  // 3) Мерджим от первой видимой колонки до конца и ставим титул
  const mergeCols = lastCol - startCol + 1;
  const mergeRange = sh.getRange(1, startCol, 1, mergeCols);
  mergeRange.merge();

  const cell = sh.getRange(1, startCol);
  cell.setValue(title)
    .setFontFamily("Inter")
    .setFontSize(10)               // чуть менее кричаще
    .setFontWeight("normal")       // тоже менее “в лоб”
    .setHorizontalAlignment("left")// слева, как ты хотел
    .setVerticalAlignment("middle")
    .setBackground("#f3f4f6")      // спокойный фон
    .setFontColor("#6b7280");      // спокойный текст

  sh.setRowHeight(1, 26);
}

/* ================= ENSURE DB + MANAGER SHEETS ================= */

function ensureDB_(ss) {
  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;

  let db = ss.getSheetByName(CFG.DB);
  if (!db) db = ss.insertSheet(CFG.DB, 0);

  // массовая запись -> глушим snapshot
  muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

  db.clear();
  removeAllBandings_(db);
  trimExtraColumns_(db, lastCol);

  // титул (только modern)
  applyTitleRow_(db);

  // header
  db.getRange(layout.headerRow, 1, 1, lastCol).setValues([CFG.DB_HEADERS]);

  // freeze
  try { db.setFrozenRows(layout.freezeRows); } catch (e) {}
  try { db.setFrozenColumns(layout.freezeCols); } catch (e) {}

  // widths
  applyColumnWidths_(db);

  // filter
  try {
    const f = db.getFilter();
    if (f) f.remove();
  } catch (e) {}
  try {
    db.getRange(layout.headerRow, 1, 1, lastCol).createFilter();
  } catch (e) {}

  // formats for body (на весь “хвост” листа)
  const maxBodyRows = Math.max(1, db.getMaxRows() - (layout.startRow - 1));
  applyStandardFormats_(db, layout.startRow, maxBodyRows);

  // plain text
  setDBPlainTextColumns_(db);

  // validations
  applyDBValidations_(db);

  // beautify
  beautifyDB_(db);

  return db;
}

function buildManagerSheets_(ss) {
  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;

  // массовая запись -> глушим snapshot
  muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

  CFG.MANAGER_SHEETS.forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);

    sh.clear();
    removeAllBandings_(sh);
    trimExtraColumns_(sh, lastCol);

    // титул
    applyTitleRow_(sh);

    // header
    sh.getRange(layout.headerRow, 1, 1, lastCol).setValues([CFG.DB_HEADERS]);

    // freeze
    try { sh.setFrozenRows(layout.freezeRows); } catch (e) {}
    try { sh.setFrozenColumns(layout.freezeCols); } catch (e) {}

    applyColumnWidths_(sh);

    // скрываем ID и Менеджер
    try { sh.hideColumn(sh.getRange(1, 1)); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, 2)); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, idx1_("Контрагент"))); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, idx1_("Самообработка"))); } catch (e) {}

    applyManagerSheetFormatting_(sh);
    applyStatusConditionalFormatting_(sh);
  });
}

/* ================= DEMO DATA ================= */

function insertSampleData_(db) {
  const layout = getLayout_();
  const now = new Date();

  const r = new Array(CFG.DB_HEADERS.length).fill("");
  r[idx0_("ID")] = nextRowId_();
  r[idx0_("Менеджер")] = CFG.MANAGER_SHEETS[0] || "Alpha";
  r[idx0_("Контрагент")] = "@example";
  r[idx0_("Самообработка")] = "Да";
  r[idx0_("Проект")] = CFG.PROJECTS[0] || "1xBet";
  r[idx0_("Логин")] = "alpha@mail.com";
  r[idx0_("Пароль")] = "pass123";
  r[idx0_("Ссылка")] = "https://example.com";
  r[idx0_("Баланс")] = 1200;
  r[idx0_("Дата баланса")] = new Date();
  r[idx0_("Статус")] = "● Активно";
  r[idx0_("Оценка контрагента")] = "⭐⭐⭐⭐⭐";
  r[idx0_("Заметка")] = "demo";
  r[idx0_("Отправлено")] = 300;
  r[idx0_("Готово к выводу")] = 150;
  r[idx0_("На выводе")] = 50;
  r[idx0_("Статус денег")] = "🟦 Отыгрывается"; // вручную
  r[idx0_("Обновлено")] = now;

  db.getRange(layout.startRow, 1, 1, CFG.DB_HEADERS.length).setValues([r]);
  beautifyDB_(db);
}

/* ================= MANAGER ACTION ================= */

function managerRefreshMyData() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  const managerName = sh.getName();

  if (!isManagerSheetName_(managerName)) {
    SpreadsheetApp.getUi().alert("Открой лист менеджера.");
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    SpreadsheetApp.getUi().alert("⏳ Уже выполняется.");
    return;
  }

  try {
    // на время перерисовки "глушим" snapshot
    muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

    const res = withSpreadsheetRetry_(() => pushManagerEditsToDB_(ss, managerName), 4);
    withSpreadsheetRetry_(() => refreshManagerSheet_(ss, managerName), 4);

    SpreadsheetApp.getUi().alert(
      `Готово ✅
Обновлено в БД: ${res.updated}
Пропущено: ${res.skipped}

` +
      `Дата баланса / Обновлено не меняются из-за перерисовки.`
    );
  } finally {
    lock.releaseLock();
  }
}

/* ================= ADMIN COLLECT ================= */

function adminCollectAllManagers() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;

  let totalUpdated = 0, totalSkipped = 0;

  try {
    CFG.MANAGER_SHEETS.forEach(m => {
      const res = withSpreadsheetRetry_(() => pushManagerEditsToDB_(ss, m), 4);
      totalUpdated += res.updated;
      totalSkipped += res.skipped;
    });
  } finally {
    lock.releaseLock();
  }

  SpreadsheetApp.getUi().alert(
    `Готово ✅
Обновлено: ${totalUpdated}
Пропущено: ${totalSkipped}`
  );
}

/* ================= CORE ================= */

function refreshManagerSheet_(ss, managerName, opts) {
  opts = opts || {};
  const includeHidden = !!opts.includeHiddenStatuses;
  const layout = getLayout_();

  const db = getSheetOrThrow_(ss, CFG.DB);
  const sh = getSheetOrThrow_(ss, managerName);
  const lastCol = CFG.DB_HEADERS.length;

  // перерисовка -> глушим snapshot, чтобы он не "актуализировал" даты
  muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

  const lastRow = db.getLastRow();
  const data = lastRow >= layout.startRow
    ? db.getRange(layout.startRow, 1, lastRow - (layout.startRow - 1), lastCol).getValues()
    : [];

  const iManager = idx0_("Менеджер");
  const iStatus  = idx0_("Статус");
  const iCp      = idx0_("Контрагент");
  const iProject = idx0_("Проект");
  const iId      = idx0_("ID");

  let rows = data.filter(r => {
    if (String(r[iManager] || "") !== managerName) return false;
    if (!includeHidden) {
      const st = String(r[iStatus] || "");
      if (CFG.HIDE_FROM_MANAGERS_STATUSES.includes(st)) return false;
    }
    return true;
  });

  rows.sort((a, b) =>
    String(a[iCp]).localeCompare(String(b[iCp])) ||
    String(a[iProject]).localeCompare(String(b[iProject])) ||
    String(a[iId]).localeCompare(String(b[iId]))
  );

  const protectedCols = [
    "Отправлено",
    "Готово к выводу",
    "На выводе",
    "Статус денег",
    "Обновлено"
  ];

  // preserve protected cols by ID from current manager sheet
  const preserve = new Map();
  const shLast = sh.getLastRow();
  if (shLast >= layout.startRow) {
    const cur = sh.getRange(
      layout.startRow, 1,
      shLast - layout.startRow + 1, lastCol
    ).getValues();

    cur.forEach(r => {
      const id = String(r[iId] || "").trim();
      if (!id) return;
      const obj = {};
      protectedCols.forEach(c => {
        obj[c] = r[idx0_(c)];
      });
      preserve.set(id, obj);
    });
  }

  // build display with separators
  const display = [];
  let prevCp = null;

  rows.forEach(r => {
    const cp = String(r[iCp] || "");
    const isNewBlock = !prevCp || cp !== prevCp;
    const selfMark = String(r[idx0_("Самообработка")] || "").trim();
    const withSelf = /^(да|yes|true|1|самообработка)$/i.test(selfMark);
    if (isNewBlock) {
      if (prevCp) {
        for (let i = 0; i < CFG.SEPARATOR_ROWS; i++) {
          display.push(new Array(lastCol).fill(""));
        }
      }
      const label = new Array(lastCol).fill("");
      label[idx0_("Проект")] = withSelf ? `Контрагент: ${cp} · Самообработка` : `Контрагент: ${cp}`;
      display.push(label);
    }

    const out = r.slice();
    const id = String(out[iId] || "").trim();

    if (id && preserve.has(id)) {
      const saved = preserve.get(id);
      protectedCols.forEach(c => {
        out[idx0_(c)] = saved[c];
      });
    }

    // Данные уровня контрагента показываем только в объединённой строке над блоком.
    out[iCp] = "";
    out[idx0_("Оценка контрагента")] = "";

    display.push(out);
    prevCp = cp;
  });

  clearValidationsForTableArea_(sh);
  setManagerSheetDisplaySafely_(sh, display, lastCol);

  // проставить "Менеджер" для непустых строк
  if (display.length > 0) {
    const mgrCol = display.map(r => [String(r[iId] || "").trim() ? managerName : ""]);
    sh.getRange(layout.startRow, idx1_("Менеджер"), display.length, 1).setValues(mgrCol);
  }

  applyColumnWidths_(sh);

  if (display.length > 0) {
    applyStandardFormats_(sh, layout.startRow, display.length);
    applyManagerValidationsById_(sh, display.length);
  }

  // оформление (как “раньше”: блоки + разделители)
  applyManagerSheetFormatting_(sh);
  applyStatusConditionalFormatting_(sh);
  styleBlocksAndSeparators_(sh, display.length);
}

/* ================= PUSH MANAGER -> DB ================= */

function pushManagerEditsToDB_(ss, managerName) {
  const layout = getLayout_();

  const db = getSheetOrThrow_(ss, CFG.DB);
  const sh = getSheetOrThrow_(ss, managerName);
  const lastCol = CFG.DB_HEADERS.length;

  const dbLastRow = db.getLastRow();
  if (dbLastRow < layout.startRow) return { updated: 0, skipped: 0 };

  const dbValues = db.getRange(
    layout.startRow, 1,
    dbLastRow - (layout.startRow - 1),
    lastCol
  ).getValues();

  const idToRow = new Map();
  for (let i = 0; i < dbValues.length; i++) {
    const id = String(dbValues[i][idx0_("ID")] || "").trim();
    if (id) idToRow.set(id, { sheetRow: i + layout.startRow });
  }

  const start = layout.startRow;
  const shLastRow = sh.getLastRow();
  if (shLastRow < start) return { updated: 0, skipped: 0 };

  const numRows = shLastRow - start + 1;
  const rows = sh.getRange(start, 1, numRows, lastCol).getValues();

  const iId      = idx0_("ID");
  const iManager = idx0_("Менеджер");
  const iCp      = idx0_("Контрагент");
  const iRating  = idx0_("Оценка контрагента");

  let updated = 0;
  let skipped = 0;

  const updates = [];

  let currentCounterparty = "";
  let currentRating = "";

  for (const r of rows) {
    const id = String(r[iId] || "").trim();
    if (!id) {
      currentCounterparty = "";
      currentRating = "";
      skipped++;
      continue;
    }

    const cp = String(r[iCp] || "").trim();
    if (cp) currentCounterparty = cp;
    else if (currentCounterparty) r[iCp] = currentCounterparty;

    const ratingRaw = String(r[iRating] || "").trim();
    if (ratingRaw) currentRating = ratingRaw;
    else if (currentRating) r[iRating] = currentRating;

    const hit = idToRow.get(id);
    if (!hit) { skipped++; continue; }

    r[iManager] = managerName;

    const rating = String(r[iRating] || "").trim();
    if (rating && !CFG.RATINGS.includes(rating)) { skipped++; continue; }

    updates.push({ sheetRow: hit.sheetRow, rowValues: r });
  }

  updates.sort((a, b) => a.sheetRow - b.sheetRow);

  let i = 0;
  while (i < updates.length) {
    let j = i;
    const startRow = updates[i].sheetRow;
    const block = [updates[i].rowValues];

    while (j + 1 < updates.length && updates[j + 1].sheetRow === updates[j].sheetRow + 1) {
      j++;
      block.push(updates[j].rowValues);
    }

    db.getRange(startRow, 1, block.length, lastCol).setValues(block);
    updated += block.length;

    i = j + 1;
  }

  if (updated > 0) {
    const colUpdated = idx1_("Обновлено");
    const bodyRows = Math.max(1, dbLastRow - (layout.startRow - 1));
    db.getRange(layout.startRow, colUpdated, bodyRows, 1).setNumberFormat("dd.MM.yyyy HH:mm:ss");
  }

  return { updated, skipped };
}

/* ================= ADMIN: EXPORT DB -> ALL MANAGERS ================= */

function adminExportDBToAllManagers() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    SpreadsheetApp.getUi().alert("⏳ Уже выполняется операция.");
    return;
  }

  try {
    // выгрузка = массовая перерисовка -> глушим snapshot, чтобы не менять даты
    muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

    CFG.MANAGER_SHEETS.forEach(name => {
      withSpreadsheetRetry_(() => refreshManagerSheet_(ss, name, { includeHiddenStatuses: true }), 4);
    });

    SpreadsheetApp.getUi().alert(`Готово ✅ БД выгружена во все листы менеджеров (ВСЕ строки).
Дата баланса/Обновлено не меняются из-за выгрузки.`);
  } finally {
    lock.releaseLock();
  }
}

/* ================= VALIDATIONS (MANAGER SHEETS) ================= */

function dvList_(list, strict) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .setAllowInvalid(!strict)
    .build();
}

function applyManagerValidationsById_(sh, displayRowCount) {
  if (displayRowCount <= 0) return;

  const start = startRow_();
  const colId = idx1_("ID");
  const ids = sh.getRange(start, colId, displayRowCount, 1).getValues();

  const projectDv = dvList_(CFG.PROJECTS, false);
  const selfDv = dvList_(["", "Да"], false);
  const statusDv = dvList_(CFG.STATUSES, true);
  const ratingDv = dvList_(CFG.RATINGS, false);
  const moneyDv = dvList_(CFG.MONEY_FLOW_STATUSES, true);

  for (let i = 0; i < displayRowCount; i++) {
    const row = start + i;
    const hasId = String(ids[i][0] || "").trim() !== "";
    if (!hasId) continue;

    sh.getRange(row, idx1_("Самообработка")).setDataValidation(selfDv);
    sh.getRange(row, idx1_("Проект")).setDataValidation(projectDv);
    sh.getRange(row, idx1_("Статус")).setDataValidation(statusDv);
    sh.getRange(row, idx1_("Оценка контрагента")).setDataValidation(ratingDv);
    sh.getRange(row, idx1_("Статус денег")).setDataValidation(moneyDv);
  }
}

/* ================= TABLE DRAW HELPERS ================= */

function clearValidationsForTableArea_(sh) {
  const lastCol = CFG.DB_HEADERS.length;
  const start = startRow_();
  const maxRows = Math.max(1, sh.getMaxRows() - start + 1);
  sh.getRange(start, 1, maxRows, lastCol).clearDataValidations();
}

function setManagerSheetDisplaySafely_(sh, display, lastCol) {
  const start = startRow_();
  const hdr = headerRow_();

  // перерисовка -> глушим snapshot
  muteTimestampRepair_(CFG.TS_MUTE_SECONDS);

  trimExtraColumns_(sh, lastCol);
  const maxClear = Math.max(display.length, sh.getLastRow() - (start - 1), 1);
  sh.getRange(start, 1, maxClear, lastCol).clearContent();

  // титул (если modern)
  applyTitleRow_(sh);

  // header
  sh.getRange(hdr, 1, 1, lastCol).setValues([CFG.DB_HEADERS]);

  // data
  if (display && display.length > 0) {
    sh.getRange(start, 1, display.length, lastCol).setValues(display);
  }
}

/* ================= BLOCKS + SEPARATORS ================= */

function styleBlocksAndSeparators_(sh, displayRowCount) {
  if (displayRowCount <= 0) return;

  const start = startRow_();
  const lastCol = CFG.DB_HEADERS.length;

  const colId = 1;
  const colProject = idx1_("Проект");
  const colStatus = idx1_("Статус");

  const ids = sh.getRange(start, colId, displayRowCount, 1).getValues();

  try {
    sh.getRange(start, 1, displayRowCount, lastCol).setBorder(false, false, false, false, false, false);
  } catch (e) {}

  let prevWasLabel = false;

  for (let i = 0; i < displayRowCount; i++) {
    const r = start + i;
    const id = String(ids[i][0] || "").trim();

    if (!id) {
      const labelText = String(sh.getRange(r, colProject).getValue() || "").trim();
      if (labelText) {
        try { sh.getRange(r, colProject, 1, Math.max(1, lastCol - colProject + 1)).breakApart(); } catch (e) {}
        sh.getRange(r, 1, 1, lastCol)
          .setBackground("#f3f4f6")
          .setFontColor("#6b7280")
          .setFontWeight("normal");
        sh.getRange(r, colProject)
          .setHorizontalAlignment("left")
          .setFontWeight("bold")
          .setFontSize(10)
          .setFontColor("#334155");
        try {
          sh.getRange(r, 1, 1, lastCol).setBorder(
            true, null, true, null, null, null,
            "#cbd5e1",
            SpreadsheetApp.BorderStyle.SOLID
          );
        } catch (e) {}
        try { sh.setRowHeight(r, 23); } catch (e) {}
      } else {
        sh.getRange(r, 1, 1, lastCol)
          .setBackground("#ffffff")
          .setFontColor("#ffffff")
          .setFontWeight("normal");
        try { sh.setRowHeight(r, 8); } catch (e) {}
      }
      prevWasLabel = true;
      continue;
    }

    const isNewBlock = prevWasLabel;

    if (isNewBlock) {
      try { sh.setRowHeight(r, 31); } catch (e) {}
      sh.getRange(r, colProject).setFontWeight("bold");
      sh.getRange(r, colStatus).setFontWeight("bold");
    } else {
      try { sh.setRowHeight(r, 30); } catch (e) {}
    }

    prevWasLabel = false;
  }
}

/* ================= ID ================= */

function nextRowId_() {
  const props = PropertiesService.getDocumentProperties();
  const key = "NEXT_ROW_ID";
  const current = Number(props.getProperty(key) || "1");
  props.setProperty(key, String(current + 1));
  return "R" + String(current).padStart(6, "0");
}

function adminFillMissingIdsInDB() {
  const layout = getLayout_();

  const ss = SpreadsheetApp.getActive();
  const db = getSheetOrThrow_(ss, CFG.DB);

  const lastCol = CFG.DB_HEADERS.length;
  const lastRow = db.getLastRow();
  if (lastRow < layout.startRow) {
    SpreadsheetApp.getUi().alert("В БД нет данных (кроме шапки).");
    return;
  }

  const values = db.getRange(
    layout.startRow, 1,
    lastRow - (layout.startRow - 1),
    lastCol
  ).getValues();

  let maxNum = 0;
  for (const r of values) {
    const id = String(r[idx0_("ID")] || "").trim();
    const m = /^R0*(\d+)$/.exec(id);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }

  let next = maxNum + 1;
  let filled = 0;

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const id = String(row[idx0_("ID")] || "").trim();
    if (id) continue;

    const hasData = row.slice(1).some(v => String(v || "").trim() !== "");
    if (!hasData) continue;

    row[idx0_("ID")] = "R" + String(next).padStart(6, "0");
    next++;
    filled++;
  }

  db.getRange(layout.startRow, 1, values.length, lastCol).setValues(values);
  PropertiesService.getDocumentProperties().setProperty("NEXT_ROW_ID", String(next));

  SpreadsheetApp.getUi().alert(
    `Готово ✅
ID проставлены: ${filled}
Следующий ID: R${String(next).padStart(6, "0")}`
  );
}

/* ================= DB VALIDATIONS ================= */

function applyDBValidations_(sh) {
  const start = startRow_();
  const maxRows = Math.max(1, sh.getMaxRows() - (start - 1));

  sh.getRange(start, idx1_("Менеджер"), maxRows, 1).setDataValidation(dvList_(CFG.MANAGER_SHEETS, true));
  sh.getRange(start, idx1_("Самообработка"), maxRows, 1).setDataValidation(dvList_(["", "Да"], false));
  sh.getRange(start, idx1_("Проект"), maxRows, 1).setDataValidation(dvList_(CFG.PROJECTS, true));
  sh.getRange(start, idx1_("Статус"),  maxRows, 1).setDataValidation(dvList_(CFG.STATUSES, true));
  sh.getRange(start, idx1_("Оценка контрагента"), maxRows, 1).setDataValidation(dvList_(CFG.RATINGS, false));
  sh.getRange(start, idx1_("Статус денег"), maxRows, 1).setDataValidation(dvList_(CFG.MONEY_FLOW_STATUSES, true));
}

/* ================= DB FORMATTING ================= */

function setDBPlainTextColumns_(db) {
  const start = startRow_();
  const maxRows = Math.max(1, db.getMaxRows() - (start - 1));

  db.getRange(start, idx1_("Контрагент"), maxRows, 1).setNumberFormat("@");
  db.getRange(start, idx1_("Логин"), maxRows, 1).setNumberFormat("@");
  db.getRange(start, idx1_("Пароль"), maxRows, 1).setNumberFormat("@");
  db.getRange(start, idx1_("Ссылка"), maxRows, 1).setNumberFormat("@");
}

function beautifyDB_(db) {
  if (!db) return;

  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;
  const maxRows = db.getMaxRows();

  const bodyStart = layout.startRow;
  const bodyRows = Math.max(1, maxRows - (bodyStart - 1));

  db.getBandings().forEach(b => b.remove());
  db.setHiddenGridlines(true);

  applyTitleRow_(db);

  db.getRange(layout.headerRow, 1, 1, lastCol)
    .setFontFamily("Inter")
    .setFontSize(12)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setBackground("#0b1220")
    .setFontColor("#ffffff");

  db.getRange(bodyStart, 1, bodyRows, lastCol)
    .setFontFamily("Inter")
    .setFontSize(10)
    .setVerticalAlignment("middle")
    .setFontColor("#111827")
    .setBackground("#ffffff")
    .setWrap(false);

  db.getRange(bodyStart, 1, bodyRows, lastCol).setHorizontalAlignment("center");

  db.getRange(bodyStart, idx1_("Ссылка"), bodyRows, 1)
    .setHorizontalAlignment("left")
    .setFontColor("#2563eb")
    .setFontLine("underline");

  db.getRange(bodyStart, idx1_("Заметка"), bodyRows, 1)
    .setHorizontalAlignment("left")
    .setWrap(true);

  db.getRange(bodyStart, idx1_("Баланс"), bodyRows, 1).setHorizontalAlignment("right");
  db.getRange(bodyStart, idx1_("Отправлено"), bodyRows, 1).setHorizontalAlignment("right");
  db.getRange(bodyStart, idx1_("Готово к выводу"), bodyRows, 1).setHorizontalAlignment("right");
  db.getRange(bodyStart, idx1_("На выводе"), bodyRows, 1).setHorizontalAlignment("right");

  db.getRange(bodyStart, idx1_("Статус"), bodyRows, 1).setFontWeight("bold");

  db.getRange(1, 1, maxRows, lastCol).setBorder(
    true, true, true, true, false, true,
    "#e5e7eb",
    SpreadsheetApp.BorderStyle.SOLID
  );

  db.setRowHeight(layout.headerRow, 46);
  const limit = Math.min(maxRows, CFG.PRETTY_ROWS_LIMIT);
  for (let r = bodyStart; r <= limit; r++) db.setRowHeight(r, 30);

  applyDBConditionalFormatting_(db);
}

function applyDBConditionalFormatting_(db) {
  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;
  const idxStatus = idx1_("Статус");

  const startRow = layout.startRow;
  const maxRows = db.getMaxRows();
  const numRows = Math.max(1, maxRows - (startRow - 1));

  const fullRange = db.getRange(startRow, 1, numRows, lastCol);
  const statusRange = db.getRange(startRow, idxStatus, numRows, 1);

  const colLetter = columnToLetter_(idxStatus);
  const r0 = startRow;

  const rules = [];

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",ISEVEN(ROW()))`)
      .setBackground("#f8fafc")
      .setRanges([fullRange])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="⛔ Заблокировано")`)
      .setBackground("#fef2f2")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="⚠ Проблема")`)
      .setBackground("#fff7ed")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="◐ Пауза")`)
      .setBackground("#f5f3ff")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="○ Закрыто")`)
      .setBackground("#f3f4f6")
      .setRanges([fullRange])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("● Активно")
      .setBackground("#ecfdf5")
      .setFontColor("#065f46")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("◐ Пауза")
      .setBackground("#eef2ff")
      .setFontColor("#3730a3")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⛔ Заблокировано")
      .setBackground("#fee2e2")
      .setFontColor("#991b1b")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⚠ Проблема")
      .setBackground("#fff7ed")
      .setFontColor("#9a3412")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("○ Закрыто")
      .setBackground("#f3f4f6")
      .setFontColor("#374151")
      .setRanges([statusRange])
      .build()
  );

  db.setConditionalFormatRules(rules);
}

/* ================= MANAGER SHEETS FORMATTING ================= */

function applyManagerSheetFormatting_(sh) {
  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;
  const lastRow = Math.max(sh.getLastRow(), layout.startRow);

  sh.setHiddenGridlines(true);
  sh.getBandings().forEach(b => b.remove());

  applyTitleRow_(sh);

  sh.getRange(layout.headerRow, 1, 1, lastCol)
    .setFontFamily("Inter")
    .setFontSize(12)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setBackground("#0b1220")
    .setFontColor("#ffffff");

  const colNote = idx1_("Заметка");
  const colLink = idx1_("Ссылка");
  const colRating = idx1_("Оценка контрагента");
  const colPassword = idx1_("Пароль");
  const colBalance = idx1_("Баланс");

  if (lastRow >= layout.startRow) {
    const bodyRows = lastRow - layout.startRow + 1;

    sh.getRange(layout.startRow, 1, bodyRows, lastCol)
      .setFontFamily("Inter")
      .setFontSize(10)
      .setVerticalAlignment("middle")
      .setFontColor("#111827")
      .setBackground("#ffffff")
      .setWrap(false)
      .setHorizontalAlignment("center");

    // Правая часть таблицы — мягкий фон для лучшей читаемости больших массивов.
    sh.getRange(layout.startRow, colNote, bodyRows, lastCol - colNote + 1)
      .setBackground("#f8fafc");

    sh.getRange(layout.startRow, colPassword, bodyRows, 1).setHorizontalAlignment("left");
    sh.getRange(layout.startRow, colNote, bodyRows, 1).setHorizontalAlignment("left").setWrap(true);

    sh.getRange(layout.startRow, colLink, bodyRows, 1)
      .setHorizontalAlignment("left")
      .setFontColor("#2563eb")
      .setFontLine("underline");

    sh.getRange(layout.startRow, colRating, bodyRows, 1).setFontSize(12);
    sh.getRange(layout.startRow, colBalance, bodyRows, 1).setHorizontalAlignment("right");
  }

  sh.getRange(1, 1, lastRow, lastCol).setBorder(
    true, true, true, true, false, true,
    "#e5e7eb",
    SpreadsheetApp.BorderStyle.SOLID
  );

  sh.setRowHeight(layout.headerRow, 42);

  const limit = Math.min(Math.max(lastRow, layout.startRow), CFG.PRETTY_ROWS_LIMIT);
  for (let r = layout.startRow; r <= limit; r++) sh.setRowHeight(r, 31);
}

function applyStatusConditionalFormatting_(sh) {
  const layout = getLayout_();
  const lastCol = CFG.DB_HEADERS.length;
  const idxStatus = idx1_("Статус");

  const startRow = layout.startRow;
  const endRow = Math.max(sh.getLastRow(), startRow);
  const numRows = endRow - startRow + 1;
  if (numRows <= 0) return;

  const fullRange = sh.getRange(startRow, 1, numRows, lastCol);
  const statusRange = sh.getRange(startRow, idxStatus, numRows, 1);

  const colLetter = columnToLetter_(idxStatus);
  const r0 = startRow;
  const rules = [];

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",ISEVEN(ROW()))`)
      .setBackground("#f8fafc")
      .setRanges([fullRange])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="⛔ Заблокировано")`)
      .setBackground("#fef2f2")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="⚠ Проблема")`)
      .setBackground("#fff7ed")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="◐ Пауза")`)
      .setBackground("#f5f3ff")
      .setRanges([fullRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND($A${r0}<>"",$${colLetter}${r0}="○ Закрыто")`)
      .setBackground("#f3f4f6")
      .setRanges([fullRange])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("● Активно")
      .setBackground("#ecfdf5")
      .setFontColor("#065f46")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("◐ Пауза")
      .setBackground("#eef2ff")
      .setFontColor("#3730a3")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⛔ Заблокировано")
      .setBackground("#fee2e2")
      .setFontColor("#991b1b")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("⚠ Проблема")
      .setBackground("#fff7ed")
      .setFontColor("#9a3412")
      .setRanges([statusRange])
      .build()
  );
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("○ Закрыто")
      .setBackground("#f3f4f6")
      .setFontColor("#374151")
      .setRanges([statusRange])
      .build()
  );

  sh.setConditionalFormatRules(rules);
}

/* ================= ADMIN: RESTORE FORMAT ================= */

function adminRestoreFormatActiveSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  const name = sh.getName();

  const layout = getLayout_();

  if (name === CFG.DB) {
    applyTitleRow_(sh);
    trimExtraColumns_(sh, CFG.DB_HEADERS.length);
    applyColumnWidths_(sh);
    try { sh.setFrozenRows(layout.freezeRows); } catch (e) {}
    try { sh.setFrozenColumns(layout.freezeCols); } catch (e) {}

    applyStandardFormats_(sh, layout.startRow, Math.max(1, sh.getMaxRows() - (layout.startRow - 1)));
    setDBPlainTextColumns_(sh);
    applyDBValidations_(sh);
    beautifyDB_(sh);

    SpreadsheetApp.getUi().alert("Готово ✅ Формат БД восстановлен.");
    return;
  }

  if (CFG.MANAGER_SHEETS.includes(name)) {
    applyTitleRow_(sh);

    trimExtraColumns_(sh, CFG.DB_HEADERS.length);
    applyColumnWidths_(sh);
    try { sh.setFrozenRows(layout.freezeRows); } catch (e) {}
    try { sh.setFrozenColumns(layout.freezeCols); } catch (e) {}

    try { sh.hideColumn(sh.getRange(1, 1)); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, 2)); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, idx1_("Контрагент"))); } catch (e) {}
    try { sh.hideColumn(sh.getRange(1, idx1_("Самообработка"))); } catch (e) {}

    applyManagerSheetFormatting_(sh);
    applyStatusConditionalFormatting_(sh);

    const displayCount = Math.max(0, sh.getLastRow() - layout.startRow + 1);
    if (displayCount > 0) {
      applyStandardFormats_(sh, layout.startRow, displayCount);
      applyManagerValidationsById_(sh, displayCount);
      styleBlocksAndSeparators_(sh, displayCount);
    }

    SpreadsheetApp.getUi().alert("Готово ✅ Формат листа менеджера восстановлен.");
    return;
  }

  SpreadsheetApp.getUi().alert("Открой лист БД или лист менеджера и запусти ещё раз.");
}

/* ================= ID PROTECTION ================= */

function protectIdColumns_() {
  const ss = SpreadsheetApp.getActive();
  const layout = getLayout_();
  const me = Session.getEffectiveUser().getEmail();
  const sheetsToProtect = [CFG.DB].concat(CFG.MANAGER_SHEETS);
  const lastCol = CFG.DB_HEADERS.length;

  sheetsToProtect.forEach(sheetName => {
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return;

    const headers = sh.getRange(layout.headerRow, 1, 1, lastCol).getValues()[0];
    const idCol0 = headers.indexOf("ID");
    if (idCol0 === -1) return;

    const col = idCol0 + 1;

    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE)
      .filter(p => {
        const r = p.getRange();
        return r.getColumn() === col && r.getNumColumns() === 1;
      })
      .forEach(p => p.remove());

    const start = layout.startRow;
    const nRows = Math.max(1, sh.getMaxRows() - start + 1);
    const range = sh.getRange(start, col, nRows, 1);

    const protection = range.protect().setDescription("AUTO: ID LOCK (NO MANUAL EDIT)");
    protection.removeEditors(protection.getEditors());
    protection.addEditor(me);
    protection.setWarningOnly(false);

    try {
      if (protection.canDomainEdit()) protection.setDomainEdit(false);
    } catch (e) {}
  });

  SpreadsheetApp.getUi().alert("Готово ✅ Колонка ID защищена (только тело таблицы).");
}

/* ================= onSelectionChange (focus marker) =================
   Лёгкий focus-маркер строки на листах менеджеров, чтобы не путаться.
*/

function onSelectionChange(e) {
  if (!e || !e.range) return;

  const ss = SpreadsheetApp.getActive();
  const sh = e.range.getSheet();
  const sheetName = sh.getName();
  const isManager = CFG.MANAGER_SHEETS.includes(sheetName);

  // Всегда очищаем старый маркер при смене выделения.
  clearSelectionMarker_(ss);
  if (!isManager) return;

  const layout = getLayout_();
  const row = e.range.getRow();
  if (row < layout.startRow) return;
  if (e.range.getNumRows() !== 1) return;

  const id = String(sh.getRange(row, idx1_("ID"), 1, 1).getValue() || "").trim();
  if (!id) return; // заголовки блоков/пустые строки не подсвечиваем

  setSelectionMarker_(sh, row);
  PropertiesService.getDocumentProperties().setProperty(SELECTION_MARKER_KEY, `${sheetName}||${row}`);
}

/* ================= onEdit (timestamps) =================
   ЖЕЛЕЗНО: работаем ТОЛЬКО на листах менеджеров.
   В БД ничего не автопроставляем.
*/

function onEdit(e) {
  if (!e || !e.range) return;

  const layout = getLayout_();

  const sh = e.range.getSheet();
  const sheetName = sh.getName();

  const isManager = CFG.MANAGER_SHEETS.includes(sheetName);
  if (!isManager) return; // ✅ DB и любые другие листы игнорируем полностью

  const startRow = e.range.getRow();
  const numRows = e.range.getNumRows();
  if (numRows > 20) return;

  const endRow = startRow + numRows - 1;
  if (endRow < layout.startRow) return;

  const startCol = e.range.getColumn();
  const endCol = startCol + e.range.getNumColumns() - 1;

  const colId = 1;
  const colBalance = idx1_("Баланс");
  const colBalanceDate = idx1_("Дата баланса");

  const colW1 = idx1_("Отправлено");
  const colW2 = idx1_("Готово к выводу");
  const colW3 = idx1_("На выводе");
  const colMoney = idx1_("Статус денег");

  const colUpdated = idx1_("Обновлено");

  const balanceEdited = (colBalance >= startCol && colBalance <= endCol);
  const moneyEdited =
    (colW1 >= startCol && colW1 <= endCol) ||
    (colW2 >= startCol && colW2 <= endCol) ||
    (colW3 >= startCol && colW3 <= endCol) ||
    (colMoney >= startCol && colMoney <= endCol);

  if (!balanceEdited && !moneyEdited) return;

  const now = new Date();
  const idVals = sh.getRange(startRow, colId, numRows, 1).getValues();

  if (balanceEdited && colBalanceDate > 0) {
    const out = idVals.map(([id]) => [String(id || "").trim() ? now : ""]);
    sh.getRange(startRow, colBalanceDate, numRows, 1).setValues(out);
  }

  if (moneyEdited && colUpdated > 0) {
    const out = idVals.map(([id]) => [String(id || "").trim() ? now : ""]);
    sh.getRange(startRow, colUpdated, numRows, 1).setValues(out);
  }
}

/* ================= SNAPSHOT REPAIR SYSTEM =================
   ЖЕЛЕЗНО:
   - работает ТОЛЬКО на листах менеджеров
   - если включен mute (после скриптовых перерисовок), НЕ ТРОГАЕТ ДАТЫ
     но обновляет baseline snapshot, чтобы потом не "догонял" и не менял даты.
*/


const SELECTION_MARKER_KEY = "SYS_SELECTION_MARKER";

function clearSelectionMarker_(ss) {
  const props = PropertiesService.getDocumentProperties();
  const raw = String(props.getProperty(SELECTION_MARKER_KEY) || "");
  if (!raw) return;

  const [sheetName, rowStr] = raw.split("||");
  const row = Number(rowStr || "0");
  if (!sheetName || !row) return;

  const sh = ss.getSheetByName(sheetName);
  if (!sh) return;

  const colProject = idx1_("Проект");
  try {
    sh.getRange(row, colProject, 1, 1).setBorder(null, false, null, null, null, null);
  } catch (e) {}

  props.deleteProperty(SELECTION_MARKER_KEY);
}

function setSelectionMarker_(sh, row) {
  const colProject = idx1_("Проект");
  try {
    sh.getRange(row, colProject, 1, 1).setBorder(
      null, true, null, null, null, null,
      "#2563eb",
      SpreadsheetApp.BorderStyle.SOLID_THICK
    );
  } catch (e) {}
}

const SNAPSHOT_SHEET = "_SNAPSHOT";

function ensureSnapshotSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SNAPSHOT_SHEET);
  if (!sh) sh = ss.insertSheet(SNAPSHOT_SHEET);

  const headers = ["sheet","id","balance","w1","w2","w3","moneyStatus","lastSeenTs"];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  try { sh.hideSheet(); } catch (e) {}
  return sh;
}

function snapshotKey_(sheetName, id) {
  return sheetName + "||" + id;
}

function normalizeNumber_(v) {
  if (v === "" || v === null || typeof v === "undefined") return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : "";
  const s = String(v).trim().replace(/\s+/g, "").replace(",", ".");
  if (!s) return "";
  const x = Number(s);
  return Number.isFinite(x) ? x : s;
}

function normalizeText_(v) {
  return String(v === null || typeof v === "undefined" ? "" : v).trim();
}

function repairTimestampsBySnapshot_() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return; }

  try {
    const layout = getLayout_();
    const muted = isTimestampRepairMuted_(); // ✅ ключевой флаг

    const ss = SpreadsheetApp.getActive();
    const snapSh = ensureSnapshotSheet_();

    // ✅ ТОЛЬКО менеджеры (БД исключаем)
    const sheets = CFG.MANAGER_SHEETS.slice();

    const colId = 1;
    const colBalance = idx1_("Баланс");
    const colBalanceDate = idx1_("Дата баланса");
    const colW1 = idx1_("Отправлено");
    const colW2 = idx1_("Готово к выводу");
    const colW3 = idx1_("На выводе");
    const colMoney = idx1_("Статус денег");
    const colUpdated = idx1_("Обновлено");

    const snapLastRow = snapSh.getLastRow();
    const snapMap = new Map();

    if (snapLastRow >= 2) {
      const snapVals = snapSh.getRange(2, 1, snapLastRow - 1, 8).getValues();
      snapVals.forEach(r => {
        const sheetName = normalizeText_(r[0]);
        const id = normalizeText_(r[1]);
        if (!sheetName || !id) return;
        snapMap.set(snapshotKey_(sheetName, id), {
          balance: r[2], w1: r[3], w2: r[4], w3: r[5], moneyStatus: r[6]
        });
      });
    }

    const now = new Date();
    const newSnapRows = [];

    sheets.forEach(sheetName => {
      const sh = ss.getSheetByName(sheetName);
      if (!sh) return;

      const lastRow = sh.getLastRow();
      if (lastRow < layout.startRow) return;

      const n = lastRow - layout.startRow + 1;

      const ids = sh.getRange(layout.startRow, colId, n, 1).getValues();
      const balances = sh.getRange(layout.startRow, colBalance, n, 1).getValues();

      // даты читаем/пишем только если НЕ muted
      const balDates = muted ? null : sh.getRange(layout.startRow, colBalanceDate, n, 1).getValues();

      const w1 = sh.getRange(layout.startRow, colW1, n, 1).getValues();
      const w2 = sh.getRange(layout.startRow, colW2, n, 1).getValues();
      const w3 = sh.getRange(layout.startRow, colW3, n, 1).getValues();
      const money = sh.getRange(layout.startRow, colMoney, n, 1).getValues();

      const updated = muted ? null : sh.getRange(layout.startRow, colUpdated, n, 1).getValues();

      let balDatesChanged = false;
      let updatedChanged = false;

      for (let i = 0; i < n; i++) {
        const id = normalizeText_(ids[i][0]);
        if (!id) continue;

        const key = snapshotKey_(sheetName, id);

        const curBalance = normalizeNumber_(balances[i][0]);
        const curW1 = normalizeNumber_(w1[i][0]);
        const curW2 = normalizeNumber_(w2[i][0]);
        const curW3 = normalizeNumber_(w3[i][0]);
        const curMoney = normalizeText_(money[i][0]);

        const prev = snapMap.get(key) || { balance: "", w1: "", w2: "", w3: "", moneyStatus: "" };

        // ✅ если muted — НИЧЕГО не ставим в даты
        if (!muted) {
          const balanceChanged = String(prev.balance) !== String(curBalance);
          if (balanceChanged) {
            balDates[i][0] = now;
            balDatesChanged = true;
          }

          const moneyChanged =
            String(prev.w1) !== String(curW1) ||
            String(prev.w2) !== String(curW2) ||
            String(prev.w3) !== String(curW3) ||
            String(prev.moneyStatus) !== String(curMoney);

          if (moneyChanged && updated) {
            updated[i][0] = now;
            updatedChanged = true;
          }
        }

        // snapshot baseline обновляем всегда
        newSnapRows.push([sheetName, id, curBalance, curW1, curW2, curW3, curMoney, now]);
      }

      if (!muted && balDatesChanged && balDates) {
        sh.getRange(layout.startRow, colBalanceDate, n, 1).setValues(balDates);
      }
      if (!muted && updatedChanged && updated) {
        sh.getRange(layout.startRow, colUpdated, n, 1).setValues(updated);
      }
    });

    const clearTo = Math.max(snapLastRow, newSnapRows.length + 1, 2);
    snapSh.getRange(2, 1, clearTo - 1, 8).clearContent();

    if (newSnapRows.length > 0) {
      snapSh.getRange(2, 1, newSnapRows.length, 8).setValues(newSnapRows);
    }

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ✅ Публичные обёртки (чтобы были видны в списке триггеров)
function setupSnapshotRepairTrigger() {
  return setupSnapshotRepairTrigger_();
}

function repairTimestampsBySnapshot() {
  return repairTimestampsBySnapshot_();
}

function setupSnapshotRepairTrigger_() {
  ensureSnapshotSheet_();

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction && t.getHandlerFunction() === "repairTimestampsBySnapshot_") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("repairTimestampsBySnapshot_")
    .timeBased()
    .everyMinutes(1)
    .create();

  SpreadsheetApp.getUi().alert(`Готово ✅ Ремонтёр по snapshot включен (раз в минуту).
Он не меняет даты после скриптовых перерисовок.`);
}
