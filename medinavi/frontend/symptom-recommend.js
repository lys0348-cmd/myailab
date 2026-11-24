// 증상 기반 추천: 증상 문장 → AI 증상 분류(분류만) → 사용자 확인 → 규칙표로 역량 판정 → 이동시간순 1~5순위.
// 판정 규칙은 서버의 /api/rules(data/recommendation_rules.json)에서 읽는다.
// 규칙표는 「119구급대원 현장응급처치 표준지침(2023)」의 이송병원 선정 기준을 옮긴 것이다:
//  - 분류마다 variants(중증/경증/체크 항목별 기준)가 있고, 위에서부터 맞는 첫 기준을 적용한다.
//  - 중증/경증은 구급대원이 고른 Pre-KTAS로 정한다 (1·2단계 또는 미입력 = 중증, 3~5단계 = 경증).
//  - 기준마다 최소 기관 등급(level)이 있다. 조건은 맞지만 등급만 낮은 기관은 '의료지도 필요'로 따로 보여준다.
(() => {
  const $ = selector => document.querySelector(selector);
  const form = $("#symptom-search");
  const input = $("#symptom-query");
  const button = $("#symptom-button");
  const status = $("#symptom-status");
  const dialog = $("#symptom-confirm");
  const categorySelect = $("#confirm-category");
  const categorySelect2 = $("#confirm-category2");
  const keywordsText = $("#confirm-keywords");
  const childBox = $("#confirm-child");
  const minutesInput = $("#rec-minutes");
  const typeSelect = $("#rec-type");
  const requiredText = $("#confirm-required");
  const note = $("#symptom-note");
  const area = $("#recommend-area");
  const areaStatus = $("#recommend-status");
  const results = $("#recommend-results");
  const unknownBox = $("#recommend-unknown");
  const unknownList = $("#recommend-unknown-list");
  const unknownSummary = $("#recommend-unknown-summary");
  const partialBox = $("#recommend-partial");
  const partialList = $("#recommend-partial-list");
  const partialSummary = $("#recommend-partial-summary");
  const capacityBox = $("#recommend-capacity");
  const capacityList = $("#recommend-capacity-list");
  const capacitySummary = $("#recommend-capacity-summary");
  // 추가(표준지침): 조건은 맞지만 지침 등급보다 낮은 가까운 기관 (의료지도 필요)
  const guidedBox = $("#recommend-guided");
  const guidedList = $("#recommend-guided-list");
  const guidedSummary = $("#recommend-guided-summary");
  // 추가(표준지침): Pre-KTAS 선택 칸(기본 화면)과 분류별 체크 항목
  const ktasSelect = $("#confirm-ktas");
  const flagsBox = $("#confirm-flags");
  // 추가: 환자 나이 직접 입력 (숫자 + 세/개월). 나이가 있으면 소아 여부는 나이로 정하고, 없으면 '소아' 체크박스를 쓴다.
  const ageInput = $("#confirm-age");
  const ageUnit = $("#confirm-age-unit");
  const fallbackBox = $("#recommend-fallback");
  const explainArea = $("#explain-area");
  const explainButton = $("#explain-button");
  const explainBox = $("#explain-box");
  const explainSummary = $("#explain-summary");
  const explainReasons = $("#explain-reasons");
  const explainStatus = $("#explain-status");
  // AI 설명에 보낼 마지막 추천 결과 (판정과 근거만 담는다)
  let explainPayload = null;
  const notice = $("#recommend-notice");
  const refineForm = $("#refine-form");
  const refineInput = $("#refine-query");
  const refineButton = $("#refine-button");
  const refineStatus = $("#refine-status");
  const refineCurrent = $("#refine-current");
  let rules = null;
  let request = null;
  // 조건 바꾸기: 직전 검색 조건과, 확인창에 올라간(아직 검색 전) 문장
  let lastCondition = null;
  let pendingQuery = "";

  async function loadRules() {
    if (rules) return rules;
    const response = await fetch("/api/rules", {cache: "no-store"});
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.categories) throw new Error("추천 규칙표를 읽지 못했어요.");
    rules = body;
    categorySelect.replaceChildren();
    for (const category of rules.categories) categorySelect.add(new Option(category.label, category.id));
    categorySelect2.replaceChildren(new Option("없음", ""));
    for (const category of rules.categories) if (category.id !== "unclear") categorySelect2.add(new Option(category.label, category.id));
    for (const badge of document.querySelectorAll(".rules-badge")) {
      badge.textContent = rules.status + (rules.pre_ktas?.enabled ? "" : " · Pre-KTAS " + (rules.pre_ktas?.notice || "미적용"));
    }
    return rules;
  }

  function category(id) {
    return rules.categories.find(item => item.id === id) || rules.categories.find(item => item.id === "unclear");
  }

  // ---- 표준지침 기준 고르기 ------------------------------------------------
  // Pre-KTAS: 기본 화면은 확인창의 선택 칸, 새 화면(index_joonghee)은 window.medinaviPreKtas()에서 읽는다.
  function currentKtas() {
    if (ktasSelect) return String(ktasSelect.value || "");
    return String(window.medinaviPreKtas?.() || "");
  }
  // 1·2단계 또는 미입력은 중증, 3~5단계는 경증 (지침 p.61: 애매하면 높은 단계)
  function severityOf(ktas) {
    const severe = rules.pre_ktas?.severe_levels || [1, 2];
    return !ktas || severe.includes(Number(ktas)) ? "severe" : "mild";
  }
  function severityText(ktas) {
    const name = rules.pre_ktas?.levels?.[ktas];
    return ktas ? "Pre-KTAS " + ktas + (name ? "(" + name + ")" : "") + " → " + (severityOf(ktas) === "severe" ? "중증" : "경증") + " 기준"
      : "Pre-KTAS 미입력 → 중증 기준";
  }

  // 분류에 맞는 기준 하나: when(중증도·체크 항목·소아)이 모두 맞는 첫 기준
  function variantOf(selected, {ktas = "", flags = new Set(), isChild = false, ageMonths = null} = {}) {
    const severity = selected.severity_fixed || severityOf(ktas);
    const variants = selected.variants || [{title: selected.label, level: "any", required: selected.required, required_any: selected.required_any, reference: selected.reference}];
    return variants.find(variant => {
      const when = variant.when || {};
      return (!when.severity || when.severity === severity) && (!when.flag || flags.has(when.flag)) && (!when.child || isChild)
        && (when.age_months_lt == null || (ageMonths != null && ageMonths < when.age_months_lt));
    }) || variants[variants.length - 1];
  }

  // ---- 나이 ----------------------------------------------------------------
  // 입력한 나이를 개월 수로 (비어 있거나 잘못되면 null)
  function ageMonthsNow() {
    const raw = String(ageInput?.value ?? "").trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    const months = Math.floor(ageUnit?.value === "개월" ? value : value * 12);
    return months <= 1500 ? months : null;
  }
  const childLimit = () => rules?.age?.child_under_months || 216;
  function isChildNow() {
    const months = ageMonthsNow();
    return months != null ? months < childLimit() : childBox.checked;
  }
  // 나이가 있으면 '소아' 체크박스를 나이에 맞춰 자동으로 정하고 잠근다.
  function syncChild() {
    const months = ageMonthsNow();
    if (months != null) childBox.checked = months < childLimit();
    childBox.disabled = months != null;
  }
  function setAge(months) {
    if (!ageInput) return;
    if (months == null) {
      ageInput.value = "";
      if (ageUnit) ageUnit.value = "세";
    } else if (months < 24 && ageUnit) {
      ageInput.value = String(months);
      ageUnit.value = "개월";
    } else {
      ageInput.value = String(Math.floor(months / 12));
      if (ageUnit) ageUnit.value = "세";
    }
  }
  function ageText(months, isChild) {
    if (months == null) return isChild ? "나이 미상(소아)" : "나이 미상";
    return months < 24 ? "생후 " + months + "개월" : Math.floor(months / 12) + "세" + (months < childLimit() ? "(소아)" : "");
  }

  function levelInfo(id) {
    return (rules.levels || []).find(level => level.id === id) || {id: "any", label: "응급의료기관", min_rank: 0};
  }
  const strictness = level => level.strictness ?? level.min_rank ?? 0;
  // 두 분류면 더 높은 등급을 쓴다.
  function strictestLevel(variants) {
    return variants.map(variant => levelInfo(variant.level)).reduce((a, b) => (strictness(b) > strictness(a) ? b : a));
  }

  // 기관 등급 확인: 가능(기준 이상) / 불가(기준보다 낮음) / 확인 필요
  function levelCheck(hospital, level) {
    const base = {kind: "level", type: "level", name: level.label};
    const type = hospital.dutyEmclsName || "구분 없음";
    if (level.trauma_center) {
      // 외상센터 표시는 tools/refresh_hospitals.py --write 로 hospitals.json에 반영한다.
      const known = (window.medinaviData?.items || []).some(item => "trauma_center" in item);
      if (!known) return {...base, status: "확인 필요", detail: "외상센터 지정 정보 미반영"};
      return {...base, status: hospital.trauma_center ? "가능" : "불가", detail: type + (hospital.trauma_center ? " · 외상센터" : "")};
    }
    const rank = rules.facility_ranks?.[hospital.dutyEmclsName];
    if (rank == null) return {...base, status: "확인 필요", detail: type};
    return {...base, status: rank >= (level.min_rank || 0) ? "가능" : "불가", detail: type};
  }

  // ---- 확인창 체크 항목 (분류별 flags) -------------------------------------
  function checkedFlags() {
    const flags = new Set();
    for (const label of flagsBox?.children || []) {
      const box = label.children?.[0];
      if (box?.checked) flags.add(box.dataset.flag);
    }
    return flags;
  }
  function renderFlags(keep = checkedFlags()) {
    if (!flagsBox) return;
    flagsBox.replaceChildren();
    const seen = new Set();
    for (const id of selectedIds()) {
      for (const flag of category(id).flags || []) {
        if (seen.has(flag.id)) continue;
        seen.add(flag.id);
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.flag = flag.id;
        box.checked = keep.has(flag.id);
        box.addEventListener("change", describeRequired);
        label.append(box, " " + flag.label);
        flagsBox.append(label);
      }
    }
    flagsBox.hidden = seen.size === 0;
  }
  function dialogContext() {
    return {ktas: currentKtas(), flags: checkedFlags(), isChild: isChildNow(), ageMonths: ageMonthsNow()};
  }

  function fillTypes() {
    if (typeSelect.options.length > 1 || !window.medinaviData) return;
    const types = [...new Set(window.medinaviData.items.map(hospital => hospital.dutyEmclsName))].filter(Boolean);
    for (const type of types) typeSelect.add(new Option(type, type));
  }

  // 확인창에서 고른 분류들 (두 번째 분류는 첫 분류와 다를 때만, 첫 분류가 '분류 어려움'이면 두 번째만)
  function selectedIds(primary = categorySelect.value, secondary = categorySelect2.value) {
    if (!secondary || secondary === primary) return [primary];
    return primary === "unclear" ? [secondary] : [primary, secondary];
  }

  function requiredTextOf(variant) {
    const required = (variant.required || []).map(item => item.name);
    const any = (variant.required_any || []).map(item => item.name);
    const parts = [];
    if (required.length) parts.push("모두 가능해야 일치: " + required.join(", "));
    if (any.length) parts.push("하나 이상 가능하면 일치: " + any.join(" 또는 "));
    return parts.length ? parts.join(" / ") : "추가 조건 없음";
  }

  // 분류 하나의 적용 기준 설명: 지침 기준 · 쪽수 · 조건 · 중증 기준(참고)
  function guideTextOf(id, context) {
    const selected = category(id);
    const variant = variantOf(selected, context);
    const parts = ["지침: " + variant.title + (selected.source ? " (" + selected.source + ")" : ""), requiredTextOf(variant)];
    if (selected.severe_signs && !selected.severity_fixed) parts.push("중증 기준(참고): " + selected.severe_signs);
    if (selected.excluded) parts.push("⚠ " + selected.exclusion_reason);
    return parts.join(" · ");
  }

  function describeRequired() {
    renderFlags();
    const ids = selectedIds();
    const context = dialogContext();
    const common = (rules.common_required || []).map(item => item.name);
    const fixed = ids.every(id => category(id).severity_fixed);
    requiredText.textContent = (fixed ? "" : severityText(context.ktas) + " | ")
      + (common.length ? "공통 수용 조건: " + common.join(", ") + " 가용 | " : "") + (ids.length === 1
      ? guideTextOf(ids[0], context)
      : ids.map(id => category(id).label + " — " + guideTextOf(id, context)).join(" | ") + " (두 분류 조건을 모두 확인하고, 기관 등급은 더 높은 쪽을 적용해요)");
  }

  function labelOf(ids) {
    return ids.map(id => category(id).label).join(" + ");
  }

  function clearArea() {
    request?.abort();
    request = null;
    results.replaceChildren();
    unknownList.replaceChildren();
    unknownBox.hidden = true;
    partialList.replaceChildren();
    partialBox.hidden = true;
    capacityList.replaceChildren();
    capacityBox.hidden = true;
    guidedList?.replaceChildren();
    if (guidedBox) guidedBox.hidden = true;
    fallbackBox.replaceChildren();
    fallbackBox.hidden = true;
    explainPayload = null;
    explainArea.hidden = true;
    explainBox.hidden = true;
    explainSummary.textContent = "";
    explainReasons.replaceChildren();
    explainStatus.textContent = "";
    areaStatus.textContent = "";
    area.hidden = true;
    refineForm.hidden = true;
  }

  // 확인창에 AI 분류 결과를 채운다. AI가 실패하면 parsed 없이 직전 값(또는 기본값)으로 연다.
  function openConfirm(parsed, fallback = null) {
    categorySelect.value = parsed?.category_id || fallback?.category_id || "unclear";
    categorySelect2.value = (parsed ? parsed.secondary_category_id : fallback?.secondary_category_id) || "";
    keywordsText.textContent = parsed?.symptom_keywords?.length
      ? "AI가 참고한 표현: " + parsed.symptom_keywords.map(word => "'" + word + "'").join(", ")
      : "AI가 참고한 표현 없음";
    childBox.checked = parsed ? parsed.is_child === true : fallback?.is_child === true;
    // 나이: AI가 문장에서 읽은 값(없으면 직전 조건의 나이). 새 검색에서 나이가 없으면 비운다.
    setAge(parsed ? (parsed.age_months ?? (fallback ? fallback.age_months ?? null : null)) : fallback?.age_months ?? null);
    syncChild();
    const minutes = parsed?.max_minutes || fallback?.max_minutes;
    if (minutes) minutesInput.value = minutes;
    if (fallback) typeSelect.value = fallback.type || "";
    // 새 검색이면 Pre-KTAS·체크 항목을 비우고, 조건 바꾸기면 직전 값을 이어받는다.
    if (ktasSelect) ktasSelect.value = fallback?.ktas || "";
    if (flagsBox) flagsBox.replaceChildren();
    renderFlags(new Set(fallback?.flags || []));
    describeRequired();
    dialog.showModal();
  }

  function shortSeverity(ktas) {
    return ktas ? "Pre-KTAS " + ktas + "(" + (severityOf(ktas) === "severe" ? "중증" : "경증") + ")" : "Pre-KTAS 미입력(중증)";
  }

  function conditionText(condition) {
    return [labelOf(selectedIds(condition.category_id, condition.secondary_category_id)), shortSeverity(condition.ktas), ageText(condition.age_months ?? null, condition.is_child),
      condition.max_minutes + "분 이내", condition.type || "전체 유형"].join(" · ");
  }

  // 직전 조건과 확인창 값을 비교해 바뀐 항목을 알려준다.
  function describeChanges(before) {
    const after = {category_id: categorySelect.value, secondary_category_id: categorySelect2.value, is_child: isChildNow(), max_minutes: Number(minutesInput.value), ktas: currentKtas(), age_months: ageMonthsNow()};
    const changes = [];
    if ((after.ktas || "") !== (before.ktas || "")) changes.push("Pre-KTAS " + (before.ktas || "미입력") + " → " + (after.ktas || "미입력"));
    const beforeLabel = labelOf(selectedIds(before.category_id, before.secondary_category_id));
    const afterLabel = labelOf(selectedIds(after.category_id, after.secondary_category_id));
    if (beforeLabel !== afterLabel) changes.push("증상 분류 " + beforeLabel + " → " + afterLabel);
    if ((after.age_months ?? null) !== (before.age_months ?? null)) changes.push("나이 " + ageText(before.age_months ?? null, before.is_child) + " → " + ageText(after.age_months, after.is_child));
    else if (after.is_child !== Boolean(before.is_child)) changes.push("소아 " + (before.is_child ? "예" : "아니오") + " → " + (after.is_child ? "예" : "아니오"));
    if (after.max_minutes !== before.max_minutes) changes.push("이동시간 " + before.max_minutes + "분 → " + after.max_minutes + "분");
    return changes.length ? "바뀐 항목: " + changes.join(", ") : "바뀐 항목이 없어요. 직전 조건 그대로예요. 필요하면 아래에서 직접 고쳐 주세요.";
  }

  // ---- 역량 판정 (공통 판정 judgement.js 사용) ----------------------------
  function evaluateOne(hospital, selected, isChild) {
    // selected: 분류에서 고른 기준(variant). 소아일 때 규칙표의 child_required를 필수 조건에 더한다.
    // 모든 환자 공통 수용 조건(응급실 병상 등) + 기준별 수용 조건(중증질환·병상·수술실·장비·진료과) + 소아 조건
    const required = [...(rules.common_required || []), ...(selected.required || []), ...(isChild ? rules.child_required || [] : [])];
    const any = selected.required_any || [];
    // 소아 공통 참고 항목이 분류의 필수·참고 항목과 겹치면 한 번만 보여준다.
    const same = (a, b) => a.type === b.type && a.name === b.name;
    const reference = [...(selected.reference || []), ...(isChild ? rules.child_reference || [] : [])]
      .filter((item, index, list) => list.findIndex(other => same(other, item)) === index && ![...required, ...any].some(other => same(other, item)));
    return window.medinaviJudge.evaluate(hospital, {required, any, reference});
  }

  // 두 분류면 분류마다 따로 판정한다: 모두 일치 → 일치, 한쪽만 일치(다른 쪽 불일치) → 일부 일치.
  // 기관 등급은 따로 확인해(level) 결과 묶음을 나눌 때 쓴다.
  function evaluate(hospital, ids, context) {
    const variants = ids.map(id => variantOf(category(id), context));
    const level = levelCheck(hospital, strictestLevel(variants));
    const each = ids.map((id, index) => ({id, ...evaluateOne(hospital, variants[index], context.isChild)}));
    const seen = new Set();
    const checks = [level, ...each.flatMap(result => result.checks)].filter(check => {
      const key = check.kind + ":" + check.type + ":" + check.name;
      return !seen.has(key) && seen.add(key);
    });
    const verdicts = each.map(result => result.verdict);
    const verdict = verdicts.every(v => v === "일치") ? "일치"
      : !verdicts.includes("불일치") ? "확인 필요"
      : each.length > 1 && verdicts.includes("일치") ? "일부 일치"
      : "불일치";
    const missing = each.filter(result => result.verdict !== "일치").map(result => result.id);
    // 진료 역량은 맞는데 지금 병상·장비가 없어서 불일치인 기관은 '지금 수용 어려움'으로 따로 보여준다.
    // 조건: 빠진 것이 병상·장비뿐이고, 중증질환·진료과 같은 진료 역량은 '가능'으로 확인돼야 한다.
    const isCapacity = check => check.type === "bed" || check.type === "equipment";
    const failing = checks.filter(check => check.kind !== "reference" && check.kind !== "level" && check.status === "불가");
    const abilityRequired = checks.filter(check => check.kind === "required" && !isCapacity(check));
    const abilityAny = checks.filter(check => check.kind === "any");
    const abilityConfirmed = abilityRequired.every(check => check.status === "가능")
      && (!abilityAny.length || abilityAny.some(check => check.status === "가능"));
    const capacity = verdict === "불일치" && failing.length > 0 && failing.every(isCapacity) && abilityConfirmed;
    return {verdict, checks, missing, capacity, level: level.status};
  }

  // ---- 추천 실행 --------------------------------------------------------
  // 결과 묶음 정하기 (표준지침 등급 반영)
  //  - 등급 충족: 일치 → 1~5순위 / 확인 필요 / 일부 일치 / 지금 수용 어려움 / 불일치 → 제외
  //  - 등급 확인 필요(외상센터 정보 미반영 등): 확인 필요 또는 지금 수용 어려움
  //  - 등급 미달: 조건이 일치하거나 확인 필요면 '의료지도 필요', 아니면 제외
  function groupOf(entry) {
    if (entry.level === "불가") return entry.verdict === "일치" || entry.verdict === "확인 필요" ? "guided" : "excluded";
    if (entry.capacity) return "busy";
    if (entry.verdict === "불일치") return "excluded";
    if (entry.level === "확인 필요") return "unknown";
    return {"일치": "recommended", "확인 필요": "unknown", "일부 일치": "partial"}[entry.verdict];
  }

  async function recommend(ids, isChild, maxMinutes, type, ktas = "", flags = [], ageMonths = null) {
    document.dispatchEvent(new CustomEvent("medinavi-search", {detail: "recommend"}));
    clearArea();
    area.hidden = false;
    const data = window.medinaviData;
    const origin = currentLocation;
    if (!origin) {
      areaStatus.textContent = "'내 위치'를 확인하거나 출발지 주소를 먼저 지정해 주세요.";
      return;
    }
    const controller = new AbortController();
    request = controller;
    const context = {ktas, flags: new Set(flags), isChild, ageMonths};
    const variants = ids.map(id => variantOf(category(id), context));
    const level = strictestLevel(variants);
    const fixed = ids.every(id => category(id).severity_fixed);
    const selectedLabel = labelOf(ids) + (fixed ? "" : " · " + shortSeverity(ktas));
    // 적용한 지침 기준과 안내(제외 사유, 소아 안내 등)를 결과 아래 안내문에 모은다.
    const notes = [
      "적용 기준: " + ids.map((id, index) => (ids.length > 1 ? category(id).label + " — " : "") + variants[index].title + (category(id).source ? " (" + category(id).source + ")" : "")).join(" / ") + ".",
      ...ids.map(id => category(id).exclusion_reason),
      ...variants.map(variant => variant.note),
      ...ids.map(id => (isChild ? category(id).child_note : "")),
    ].filter(Boolean).join(" ");
    areaStatus.textContent = "실시간 정보를 확인하고 있어요.";
    await window.medinaviRealtime?.refresh();
    if (controller.signal.aborted) return;

    const evaluated = data.items
      .filter(hospital => !type || hospital.dutyEmclsName === type)
      .map(hospital => {
        const entry = {hospital, ...evaluate(hospital, ids, context)};
        return {...entry, group: groupOf(entry)};
      });
    window.medinaviJudge.remember(evaluated);
    const excluded = evaluated.filter(entry => entry.group === "excluded").length;

    areaStatus.textContent = "병원별 예상 이동시간을 조회하고 있어요.";
    const routed = await window.medinaviJudge.lookupRoutes(evaluated.filter(entry => entry.group !== "excluded"), origin, controller.signal);
    if (!routed) return;
    const noRoute = routed.filter(entry => !entry.route).length;
    const within = routed.filter(entry => entry.route && entry.route.duration_ms <= maxMinutes * 60000)
      .sort((a, b) => a.route.duration_ms - b.route.duration_ms);
    const recommended = within.filter(entry => entry.group === "recommended").slice(0, 5);
    const unknown = within.filter(entry => entry.group === "unknown");
    const partial = within.filter(entry => entry.group === "partial");
    const busy = within.filter(entry => entry.group === "busy");
    const guided = within.filter(entry => entry.group === "guided");

    recommended.forEach((entry, index) => {
      const {hospital, route, checks} = entry;
      const item = document.createElement("li");
      const choice = document.createElement("button");
      choice.type = "button";
      choice.dataset.hpid = hospital.hpid;
      const minutes = Math.ceil(route.duration_ms / 60000);
      const distance = (route.distance_m / 1000).toFixed(1);
      const required = checks.filter(check => check.kind !== "reference");
      const reference = checks.filter(check => check.kind === "reference").slice(0, 4);
      const checkText = window.medinaviJudge.checkText;
      let text = (index + 1) + ". " + hospital.dutyName + " (" + (hospital.dutyEmclsName || "구분 확인 필요") + ") · 약 " + minutes + "분 · " + distance + "km";
      if (required.length) text += "\n조건: " + required.map(checkText).join(" · ");
      if (reference.length) text += "\n참고: " + reference.map(checkText).join(" · ");
      const realtimeText = window.medinaviRealtime?.summary(hospital.hpid);
      if (realtimeText) text += "\n" + realtimeText;
      // 병원이 직접 올린 공지(진료 불가·미운영 등)가 있으면 한 줄로 알린다.
      const noticeText = window.medinaviRealtime?.noticeText?.(hospital.hpid);
      if (noticeText) text += "\n" + noticeText;
      choice.textContent = text;
      const congestion = window.medinaviRealtime?.level(hospital.hpid);
      if (congestion) choice.dataset.congestion = congestion;
      choice.onclick = () => showHospitalDetail(hospital, data, route);
      item.append(choice);
      // 추가: 결과마다 바로 전화 버튼 (call.js)
      window.medinaviCall?.attach(item, hospital);
      results.append(item);
    });
    for (const {hospital, route, checks} of unknown) {
      const item = document.createElement("li");
      const reasons = checks.filter(check => check.kind !== "reference" && check.status !== "가능").map(window.medinaviJudge.checkText);
      item.textContent = hospital.dutyName + " · 약 " + Math.ceil(route.duration_ms / 60000) + "분 — " + reasons.join(", ");
      window.medinaviCall?.attach(item, hospital);
      unknownList.append(item);
    }
    // 두 분류 중 한쪽만 맞는 기관: 빠진 조건과 함께 따로 보여준다.
    for (const {hospital, route, checks, missing} of partial) {
      const item = document.createElement("li");
      const choice = document.createElement("button");
      choice.type = "button";
      choice.dataset.hpid = hospital.hpid;
      const lacking = checks.filter(check => check.kind !== "reference" && check.status !== "가능").map(window.medinaviJudge.checkText);
      choice.textContent = hospital.dutyName + " · 약 " + Math.ceil(route.duration_ms / 60000) + "분 — " + labelOf(missing) + " 조건 빠짐: " + lacking.join(", ");
      choice.onclick = () => showHospitalDetail(hospital, data, route);
      item.append(choice);
      window.medinaviCall?.attach(item, hospital);
      partialList.append(item);
    }
    // 지금 병상·수술실·장비가 없어 수용이 어려운 기관 (가까운 순)
    for (const {hospital, route, checks} of busy) {
      const item = document.createElement("li");
      const choice = document.createElement("button");
      choice.type = "button";
      choice.dataset.hpid = hospital.hpid;
      const lacking = checks.filter(check => check.kind !== "reference" && check.status === "불가").map(window.medinaviJudge.checkText);
      choice.textContent = hospital.dutyName + " · 약 " + Math.ceil(route.duration_ms / 60000) + "분 — " + lacking.join(", ");
      choice.onclick = () => showHospitalDetail(hospital, data, route);
      item.append(choice);
      window.medinaviCall?.attach(item, hospital);
      capacityList.append(item);
    }
    // 등급은 지침 기준보다 낮지만 조건에 맞는 가까운 기관 (의료지도를 받으면 이송 가능)
    for (const {hospital, route, checks} of guided) {
      const item = document.createElement("li");
      const choice = document.createElement("button");
      choice.type = "button";
      choice.dataset.hpid = hospital.hpid;
      const unsure = checks.filter(check => check.kind !== "reference" && check.kind !== "level" && check.status !== "가능").map(window.medinaviJudge.checkText);
      choice.textContent = hospital.dutyName + " · 약 " + Math.ceil(route.duration_ms / 60000) + "분 — " + (hospital.dutyEmclsName || "구분 없음")
        + " (지침: " + level.label + ") · 의료지도 필요" + (unsure.length ? " · " + unsure.join(", ") : "");
      choice.onclick = () => showHospitalDetail(hospital, data, route);
      item.append(choice);
      window.medinaviCall?.attach(item, hospital);
      guidedList?.append(item);
    }
    if (guidedBox) {
      guidedBox.hidden = guided.length === 0;
      guidedSummary.textContent = "의료지도 필요 (" + guided.length + "곳 · 지침 등급보다 낮지만 가까운 곳)";
      guidedBox.open = recommended.length === 0;
    }
    capacityBox.hidden = busy.length === 0;
    capacitySummary.textContent = "지금 수용 어려움 (" + busy.length + "곳 · 병상·수술실·장비 없음)";
    capacityBox.open = recommended.length === 0;
    partialBox.hidden = partial.length === 0;
    partialSummary.textContent = "일부 조건만 일치 (" + partial.length + "곳)";
    partialBox.open = recommended.length === 0;
    unknownBox.hidden = unknown.length === 0;
    // 5곳이 넘으면 접어 두고 개수만 보여준다.
    unknownSummary.textContent = "조건 확인 필요 (" + unknown.length + "곳)";
    unknownBox.open = unknown.length <= 5;
    window.hospitalRouteView?.showSearchResults(recommended);

    const summary = [
      selectedLabel,
      "예상 " + maxMinutes + "분 이내 " + (ids.length > 1 ? "모두 일치 " : "조건 일치 ") + recommended.length + "곳" + (within.filter(e => e.verdict === "일치").length > 5 ? " (상위 5곳 표시)" : ""),
      partial.length && "일부 일치 " + partial.length + "곳",
      guided.length && "의료지도 필요 " + guided.length + "곳",
      busy.length && "지금 수용 어려움 " + busy.length + "곳",
      unknown.length && "조건 확인 필요 " + unknown.length + "곳",
      excluded && "조건 불일치 " + excluded + "곳 제외",
      noRoute && "이동시간 확인 불가 " + noRoute + "곳",
    ].filter(Boolean);
    // 결과가 없으면 어디서 줄었는지 단계별로 알려준다.
    const funnel = "후보 " + evaluated.length + "곳 → " + (ids.length > 1 ? "모두 일치 " : "조건 일치 ") + routed.filter(e => e.group === "recommended").length + "곳 → " + maxMinutes + "분 이내 0곳";
    // 중증외상: 권역외상센터가 멀면 헬기 이송·의료지도 안내 (표준지침 p.54, p.325)
    let helicopter = "";
    if (level.trauma_center && rules.helicopter) {
      const centers = routed.filter(entry => entry.level === "가능" && entry.route).sort((a, b) => a.route.duration_ms - b.route.duration_ms);
      const nearest = centers[0]?.route;
      if (evaluated.some(entry => entry.level === "확인 필요" && levelCheck(entry.hospital, level).detail === "외상센터 지정 정보 미반영")) {
        helicopter = "⚠ 외상센터 지정 정보가 아직 반영되지 않아 기관 등급을 '확인 필요'로 표시했어요.";
      } else if (!nearest || nearest.duration_ms > rules.helicopter.max_minutes * 60000 || nearest.distance_m > rules.helicopter.max_km * 1000) {
        helicopter = "🚁 권역외상센터까지 " + (nearest ? "약 " + Math.ceil(nearest.duration_ms / 60000) + "분 · " + (nearest.distance_m / 1000).toFixed(1) + "km" : "이동시간을 확인하지 못했어요") + ". " + rules.helicopter.note;
      }
    }
    // 두 분류로 찾았는데 모두 일치가 없으면, 한 분류만 적용해 다시 찾는 버튼을 보여준다.
    if (!recommended.length && ids.length > 1 && lastCondition) {
      for (const id of ids) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = category(id).label + "만 적용해서 다시 찾기";
        retry.onclick = () => {
          lastCondition = {...lastCondition, category_id: id, secondary_category_id: null};
          recommend([id], isChild, maxMinutes, type, ktas, flags, ageMonths);
        };
        fallbackBox.append(retry);
      }
      fallbackBox.hidden = false;
    }
    areaStatus.textContent = summary.join(" · ") + (recommended.length ? "" : ". [" + funnel + "] 조건을 넓히거나 의료지도 필요·확인 필요 목록의 병원에 연락해 주세요.");
    notice.textContent = (helicopter ? helicopter + " " : "") + (notes ? notes + " " : "") + rules.notice + " 예상 시간은 일반 자동차 기준 참고값이에요.";
    // AI 결과 설명: 화면에 보인 판정·근거만 보내고, 버튼을 눌렀을 때만 만든다.
    const clip = (text, length) => String(text || "").slice(0, length);
    const checkText = window.medinaviJudge.checkText;
    explainPayload = {
      condition: clip([selectedLabel, level.label, ageText(ageMonths, isChild), maxMinutes + "분 이내", type || "전체 유형"].join(" · "), 200),
      hospitals: recommended.map((entry, index) => ({
        rank: index + 1,
        name: clip(entry.hospital.dutyName, 80),
        type: clip(entry.hospital.dutyEmclsName, 40),
        minutes: Math.ceil(entry.route.duration_ms / 60000),
        conditions: entry.checks.filter(check => check.kind !== "reference").slice(0, 8).map(check => clip(checkText(check), 120)),
        reference: entry.checks.filter(check => check.kind === "reference").slice(0, 4).map(check => clip(checkText(check), 120)),
        realtime: clip(window.medinaviRealtime?.summary(entry.hospital.hpid), 160),
        notice: clip(window.medinaviRealtime?.noticeText?.(entry.hospital.hpid), 200),
      })),
      partial_count: partial.length,
      unknown_count: unknown.length,
      excluded_count: excluded,
      funnel: recommended.length ? "" : clip(funnel, 200),
    };
    explainArea.hidden = false;
    explainButton.disabled = false;

    if (lastCondition) {
      refineCurrent.textContent = "현재 조건: " + conditionText(lastCondition);
      refineForm.hidden = false;
    }
    request = null;
  }

  // ---- 화면 이벤트 ------------------------------------------------------
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query || button.disabled) return;
    if (!window.medinaviData) {
      status.textContent = "지도를 준비하고 있어요. 잠시 후 다시 시도해 주세요.";
      return;
    }
    button.disabled = true;
    status.textContent = "증상을 분류하고 있어요.";
    note.textContent = "";
    try {
      await loadRules();
      fillTypes();
      let parsed = null;
      try {
        const response = await fetch("/api/symptom/parse", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({query})});
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(typeof body?.detail === "string" ? body.detail : "서버를 준비하고 있어요.");
        parsed = body;
      } catch (error) {
        // AI가 실패해도 사용자가 직접 분류를 골라 추천받을 수 있게 한다.
        note.textContent = (error.message || "AI 증상 분류에 실패했어요.") + " 증상 분류를 직접 골라 주세요.";
      }
      pendingQuery = query;
      status.textContent = "";
      // 새 증상 검색은 직전 검색의 이동시간을 이어받지 않는다 (문장에 시간이 없으면 기본 60분).
      minutesInput.value = "60";
      openConfirm(parsed);
    } catch (error) {
      status.textContent = error.message || "증상 분류를 준비하지 못했어요.";
    } finally {
      button.disabled = false;
    }
  });

  categorySelect.addEventListener("change", describeRequired);
  categorySelect2.addEventListener("change", describeRequired);
  // Pre-KTAS·소아 여부가 바뀌면 적용 기준(중증/경증, 소아 기준)도 다시 보여준다.
  ktasSelect?.addEventListener("change", describeRequired);
  childBox.addEventListener("change", describeRequired);
  const onAge = () => { syncChild(); describeRequired(); };
  ageInput?.addEventListener("input", onAge);
  ageInput?.addEventListener("change", onAge);
  ageUnit?.addEventListener("change", onAge);
  $("#symptom-edit").addEventListener("click", () => {
    dialog.close();
    input.focus();
  });
  $("#symptom-go").addEventListener("click", () => {
    const maxMinutes = Number(minutesInput.value);
    if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 600) {
      note.textContent = "최대 예상 이동시간을 1~600분 사이로 입력해 주세요.";
      return;
    }
    dialog.close();
    const ids = selectedIds();
    const ktas = currentKtas();
    const flags = [...checkedFlags()];
    const ageMonths = ageMonthsNow();
    const isChild = isChildNow();
    lastCondition = {query: pendingQuery, category_id: ids[0], secondary_category_id: ids[1] || null, is_child: isChild, max_minutes: maxMinutes, type: typeSelect.value, ktas, flags, age_months: ageMonths};
    recommend(ids, isChild, maxMinutes, typeSelect.value, ktas, flags, ageMonths);
  });

  explainButton.addEventListener("click", async () => {
    const payload = explainPayload;
    if (!payload || explainButton.disabled) return;
    explainButton.disabled = true;
    explainStatus.textContent = "AI가 결과를 설명하고 있어요.";
    try {
      const response = await fetch("/api/explain", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
      const body = await response.json().catch(() => null);
      if (payload !== explainPayload) return;   // 그사이 새로 검색했으면 버린다
      if (!response.ok || !body) throw new Error(typeof body?.detail === "string" ? body.detail : "AI 설명을 만들지 못했어요.");
      explainSummary.textContent = body.summary || "";
      explainReasons.replaceChildren();
      const names = new Map(payload.hospitals.map(hospital => [hospital.rank, hospital.name]));
      for (const reason of body.reasons || []) {
        const item = document.createElement("li");
        const strong = document.createElement("strong");
        strong.textContent = reason.rank + "순위 " + (names.get(reason.rank) || "") + ": ";
        item.append(strong, reason.text);
        explainReasons.append(item);
      }
      explainBox.hidden = false;
      explainStatus.textContent = "";
    } catch (error) {
      if (payload !== explainPayload) return;
      explainStatus.textContent = (error.message || "AI 설명을 만들지 못했어요.") + " 아래 조건별 근거를 참고해 주세요.";
      explainButton.disabled = false;
    }
  });

  // 조건 바꾸기: 직전 조건은 두고, 새로 입력한 내용에 나온 항목만 AI가 바꾼다. 결과는 확인창에서 다시 확인한다.
  refineForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const change = refineInput.value.trim();
    if (!change || !lastCondition || refineButton.disabled) return;
    refineButton.disabled = true;
    refineStatus.textContent = "바뀐 조건을 확인하고 있어요.";
    note.textContent = "";
    const before = lastCondition;
    let parsed = null;
    try {
      const previous = {query: before.query.slice(-300), category_id: before.category_id, secondary_category_id: before.secondary_category_id || null, is_child: before.is_child, max_minutes: before.max_minutes, age_months: before.age_months ?? null};
      const response = await fetch("/api/symptom/parse", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({query: change, previous})});
      const body = await response.json().catch(() => null);
      if (!response.ok || !body) throw new Error(typeof body?.detail === "string" ? body.detail : "서버를 준비하고 있어요.");
      parsed = body;
    } catch (error) {
      note.textContent = (error.message || "AI 조건 확인에 실패했어요.") + " 직전 조건을 띄웠으니 바뀐 내용을 직접 고쳐 주세요.";
    } finally {
      refineButton.disabled = false;
      refineStatus.textContent = "";
    }
    // 다음 '조건 바꾸기' 때 AI가 전체 맥락을 알 수 있게 문장을 이어 붙인다.
    pendingQuery = (before.query ? before.query + " / " : "") + change;
    openConfirm(parsed, before);
    if (parsed) note.textContent = describeChanges(before);
    refineInput.value = "";
  });

  // 조건 검색을 하거나 출발지를 바꾸면 이전 추천을 정리한다.
  document.addEventListener("medinavi-search", event => {
    if (event.detail !== "recommend") clearArea();
  });
  document.addEventListener("originchange", clearArea);
  loadRules().catch(() => {});
})();
