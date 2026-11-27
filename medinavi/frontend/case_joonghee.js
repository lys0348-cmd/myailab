// 작업 건(출동·탐색 건) 상태와 연락·수용 확인 기록. 새 화면(index_joonghee.html) 전용.
// - 이 브라우저 탭에만 임시 저장한다 (sessionStorage). 서버·병원·상황실로 보내지 않는다.
// - 환자 증상 원문이나 개인정보는 저장하지 않는다. 기관 ID·연락 결과·시각·짧은 메모만 남긴다.
// - 전화 앱을 연 것은 '연락 시도'일 뿐, 통화·수용 확인으로 기록하지 않는다.
// - 기록은 지우지 않고 쌓는다. 취소하면 취소 표시만 남긴다 (번복 이력).
window.medinaviCase = (() => {
  const KEY = "medinavi-case-v1";
  const $ = selector => document.querySelector(selector);
  const STATUS = {
    none:    {mark: "○", label: "미연락", cls: "cp-none"},
    tried:   {mark: "☎", label: "연락 시도", cls: "cp-tried"},
    waiting: {mark: "⏳", label: "확인 대기", cls: "cp-waiting"},
    retry:   {mark: "↻", label: "확인 실패·재확인 필요", cls: "cp-retry"},
    accept:  {mark: "✔", label: "수용 가능 확인", cls: "cp-accept"},
    reject:  {mark: "✖", label: "수용 불가 확인", cls: "cp-reject"},
  };
  const listeners = [];
  let state = load();
  let conditions = null;      // 화면이 알려주는 현재 검색 조건 (요약용, 저장하지 않음)
  let results = [];           // 현재 결과 [{hpid, name, minutes}]

  function fresh() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    return {
      id: String(now.getFullYear()).slice(2) + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()),
      startedAt: now.toISOString(), ktas: [], contacts: [], candidates: [], names: {},
    };
  }
  function load() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (saved?.id && Array.isArray(saved.contacts)) {
        // 예전 형식(후보 1곳)을 후보 목록으로 옮긴다.
        if (!Array.isArray(saved.candidates)) saved.candidates = saved.candidate ? [saved.candidate] : [];
        delete saved.candidate;
        return saved;
      }
    } catch (error) { /* 저장소를 못 쓰면 메모리에만 둔다 */ }
    return fresh();
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { /* 무시 */ }
    for (const listener of listeners) listener(state);
  }
  const time = iso => new Date(iso).toLocaleTimeString("ko-KR", {hour: "2-digit", minute: "2-digit", hour12: false});

  // ---- Pre-KTAS (구급대원 평가값, 평가 시각과 함께 이력으로) --------------
  function setKtas(level) {
    const last = state.ktas.at(-1);
    if ((last?.level || "") === (level || "")) return;
    state.ktas.push({level: level || "", at: new Date().toISOString()});
    save();
  }
  const ktasNow = () => state.ktas.at(-1)?.level ? state.ktas.at(-1) : null;

  // ---- 연락 기록 ----------------------------------------------------------
  function current(hpid) {
    const list = state.contacts.filter(record => record.hpid === hpid && !record.revoked);
    return list.at(-1) || null;
  }
  function add(hpid, name, status, note = "") {
    state.names[hpid] = name;
    state.contacts.push({id: Date.now() + "-" + Math.random().toString(36).slice(2, 6), hpid, status, note: note.slice(0, 80), at: new Date().toISOString(), by: "이 기기"});
    save();
  }
  function revoke(id) {
    const record = state.contacts.find(item => item.id === id);
    if (!record || record.revoked) return;
    record.revoked = new Date().toISOString();
    save();
  }

  // 전화 앱 열기 → '연락 시도'만 남기고, 돌아오면 결과를 묻는다.
  let pendingReturn = null;
  let leftAt = 0;
  function dialed(hpid, name) {
    add(hpid, name, "tried", "전화 앱 열기 (통화 여부 미확인)");
    pendingReturn = {hpid, name};
    leftAt = 0;
  }
  // [보류 2026-11-19] 연락 결과 기록 창은 화면에서 뺐다. 전화 앱에서 돌아와도 창을 띄우지 않는다 (연락 시도 기록만 남김).
  const PROMPT_ON_RETURN = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { leftAt = Date.now(); return; }
    if (PROMPT_ON_RETURN && pendingReturn && leftAt) {
      const {hpid, name} = pendingReturn;
      pendingReturn = null;
      openContact(hpid, name, true);
    }
  });

  // ---- 이송 후보 (앱 안의 표시일 뿐 배정·접수 아님, 최대 3곳 비교) ------------
  const MAX_CANDIDATES = 3;
  const isCandidate = hpid => state.candidates.some(item => item.hpid === hpid);
  function toggleCandidate(hpid, name) {
    if (isCandidate(hpid)) {
      state.candidates = state.candidates.filter(item => item.hpid !== hpid);
    } else {
      if (state.candidates.length >= MAX_CANDIDATES) return false;
      const found = results.find(item => item.hpid === hpid);
      state.candidates.push({hpid, name, minutes: found?.minutes || "", km: found?.km || "", at: new Date().toISOString()});
    }
    state.names[hpid] = name;
    save();
    return true;
  }

  // 공공데이터에 등록된 번호만 쓴다. 형식이 아니면 전화 링크를 만들지 않는다.
  function phoneOf(hospital) {
    const clean = value => (/^0\d{1,3}-?\d{3,4}-?\d{4}$/.test(String(value ?? "").trim()) ? String(value).trim() : "");
    const er = clean(hospital?.dutyTel3);
    const main = clean(hospital?.dutyTel1);
    return er ? {number: er, kind: "응급실"} : main ? {number: main, kind: "대표번호"} : null;
  }
  const hospitalOf = hpid => window.medinaviData?.items?.find(item => item.hpid === hpid) || null;

  // ---- 연락 결과 시트 -----------------------------------------------------
  const contactSheet = $("#contact-sheet");
  const grid = $("#status-grid");
  const note = $("#contact-note");
  let contactTarget = null;
  let chosen = "";
  function renderLog(list, records, withRevoke) {
    list.replaceChildren();
    for (const record of [...records].reverse()) {
      const item = document.createElement("li");
      if (record.revoked) item.className = "revoked";
      const info = STATUS[record.status] || STATUS.none;
      item.textContent = time(record.at) + " · " + (withRevoke ? "" : (state.names[record.hpid] || record.hpid) + " · ") + info.mark + " " + info.label +
        (record.note ? " · " + record.note : "") + " · " + record.by + (record.revoked ? " (취소 " + time(record.revoked) + ")" : "");
      if (withRevoke && !record.revoked) {
        const undo = document.createElement("button");
        undo.type = "button";
        undo.className = "btn small";
        undo.style.cssText = "display:inline-flex;min-height:36px;margin-left:8px;padding:0 8px;font-size:12px";
        undo.textContent = "이 기록 취소";
        undo.onclick = () => { revoke(record.id); renderContactLog(); };
        item.append(undo);
      }
      list.append(item);
    }
  }
  function renderContactLog() {
    renderLog($("#contact-log"), state.contacts.filter(record => record.hpid === contactTarget?.hpid), true);
  }
  function openContact(hpid, name, returned = false) {
    contactTarget = {hpid, name};
    chosen = "";
    note.value = "";
    for (const button of grid.children) button.setAttribute("aria-pressed", "false");
    $("#contact-hospital").textContent = name + " · 현재: " + (STATUS[current(hpid)?.status] || STATUS.none).label;
    $("#contact-return").hidden = !returned;
    renderContactLog();
    if (!contactSheet.open) contactSheet.showModal();
  }
  grid.addEventListener("click", event => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    chosen = button.dataset.status;
    for (const other of grid.children) other.setAttribute("aria-pressed", String(other === button));
  });
  $("#contact-save").addEventListener("click", () => {
    if (!contactTarget) return;
    if (!chosen) { $("#contact-hospital").textContent = contactTarget.name + " · 결과를 먼저 골라 주세요."; return; }
    add(contactTarget.hpid, contactTarget.name, chosen, note.value.trim());
    contactSheet.close();
    toast(contactTarget.name + ": " + STATUS[chosen].label + " 기록했어요.");
  });

  // ---- 작업 건 시트 · 전달용 요약 -------------------------------------------
  const caseSheet = $("#case-sheet");
  function handover() {
    const k = ktasNow();
    const lines = ["[메디네비 작업 건 " + state.id + "]"];
    if (conditions) {
      lines.push("출발지: " + (conditions.origin || "확인 전"));
      lines.push("진료 조건: " + conditions.category + (conditions.aiInterpreted ? " (AI 정리 후 구급대원 확인)" : ""));
    }
    lines.push("Pre-KTAS: " + (k ? k.level + "등급 (" + time(k.at) + " 평가)" : "미입력"));
    state.candidates.forEach((candidate, index) => {
      const contact = current(candidate.hpid);
      lines.push("이송 후보 " + (index + 1) + ": " + candidate.name + (candidate.minutes ? " · 예상 " + candidate.minutes + "분(일반 자동차 기준)" : "") +
        " · 수용 확인: " + (contact ? STATUS[contact.status].label + " " + time(contact.at) : "미연락"));
    });
    const others = [...new Set(state.contacts.filter(r => !r.revoked).map(r => r.hpid))].filter(id => !isCandidate(id));
    if (others.length) lines.push("기타 연락: " + others.map(id => (state.names[id] || id) + " " + STATUS[current(id)?.status || "none"].label).join(", "));
    return lines.join("\n");
  }
  // 후보 비교: 같은 항목을 나란히 (공공데이터 값과 직접 연락 결과를 섞지 않음)
  function renderCompare() {
    const list = $("#case-candidates");
    list.replaceChildren();
    $("#case-cand-count").textContent = "(" + state.candidates.length + "/" + MAX_CANDIDATES + ")";
    $("#case-cand-empty").hidden = state.candidates.length > 0;
    for (const candidate of state.candidates) {
      const hospital = hospitalOf(candidate.hpid) || {};
      const contact = current(candidate.hpid);
      const info = STATUS[contact?.status || "none"];
      const phone = phoneOf(hospital);
      const item = document.createElement("li");
      const head = document.createElement("div");
      head.className = "cmp-head";
      const name = document.createElement("strong");
      name.textContent = candidate.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn small";
      remove.textContent = "후보에서 빼기";
      remove.onclick = () => { toggleCandidate(candidate.hpid, candidate.name); renderCompare(); $("#handover-text").value = handover(); };
      head.append(name, remove);
      const dl = document.createElement("dl");
      const row = (term, value, cls) => {
        const dt = document.createElement("dt"); dt.textContent = term;
        const dd = document.createElement("dd"); dd.textContent = value; if (cls) dd.className = cls;
        dl.append(dt, dd);
      };
      row("이번 환자 수용", info.mark + " " + info.label + (contact ? " · " + time(contact.at) : ""), info.cls);
      row("예상 이동", candidate.minutes ? "약 " + candidate.minutes + "분" + (candidate.km ? " · " + candidate.km + "km" : "") + " (표시 당시 · 일반 자동차)" : "확인 필요");
      row("기관 유형", window.medinaviJudge?.typeText(hospital, "확인 필요") || hospital.dutyEmclsName || "확인 필요");
      row("병상 (공공데이터)", window.medinaviRealtime?.summary?.(candidate.hpid) || "미제공 (0이나 불가가 아님)");
      row("연락처", phone ? phone.kind + " " + phone.number : "등록 번호 없음 · 상황실 절차로");
      item.append(head, dl);
      if (contact?.status !== "accept") {
        const warn = document.createElement("p");
        warn.className = "note";
        warn.textContent = "수용 가능 확인 기록이 없어요. 후보 표시는 수용 확인이 아니에요.";
        item.append(warn);
      }
      list.append(item);
    }
  }
  function openCase() {
    $("#case-meta").textContent = "작업 건 " + state.id + " · " + time(state.startedAt) + " 시작";
    renderCompare();
    renderLog($("#case-log"), state.contacts, false);
    $("#handover-text").value = handover();
    if (!caseSheet.open) caseSheet.showModal();
  }
  $("#handover-refresh").addEventListener("click", () => { $("#handover-text").value = handover(); });
  $("#handover-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#handover-text").value); toast("복사했어요. 붙여넣기 전에 내용을 확인해 주세요."); }
    catch (error) { $("#handover-text").select(); toast("자동 복사가 안 돼요. 선택된 글을 길게 눌러 복사해 주세요."); }
  });
  $("#case-new").addEventListener("click", () => {
    if (!confirm("지금 작업 건의 연락 기록·이송 후보를 지우고 새 건을 시작할까요?")) return;
    state = fresh();
    save();
    caseSheet.close();
    toast("새 작업 건 " + state.id + "을 시작했어요.");
  });

  // ---- 상단 작업 건 줄 ----------------------------------------------------
  function renderBar() {
    const contacted = new Set(state.contacts.filter(r => !r.revoked).map(r => r.hpid)).size;
    const accepted = [...new Set(state.contacts.map(r => r.hpid))].filter(id => current(id)?.status === "accept").length;
    const k = ktasNow();
    $("#case-line").innerHTML = "<b>작업 건 " + state.id + "</b> · Pre-KTAS " + (k ? k.level : "미입력") +
      " · 연락 " + contacted + "곳" + (accepted ? " · 수용 가능 확인 " + accepted + "곳" : "") +
      (state.candidates.length ? " · 후보 " + state.candidates.length + "/" + MAX_CANDIDATES : "");
  }
  $("#case-open").addEventListener("click", openCase);
  listeners.push(renderBar);

  // ---- 알림 ---------------------------------------------------------------
  let toastTimer = null;
  function toast(message) {
    const box = $("#toast");
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 3500);
  }

  renderBar();
  return {
    STATUS, MAX_CANDIDATES, time, setKtas, ktasNow, current, add, dialed, toggleCandidate, isCandidate, phoneOf, openContact, openCase, toast,
    candidateCount: () => state.candidates.length,
    onChange: listener => listeners.push(listener),
    setConditions: value => { conditions = value; },
    setResults: value => { results = value; },
  };
})();
