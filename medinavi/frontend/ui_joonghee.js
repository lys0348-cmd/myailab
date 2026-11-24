// 새 화면(index_joonghee.html) 전용. 기존 스크립트(map.js, symptom-recommend.js 등)는 고치지 않고,
// 그 결과를 읽어 시안 모양(홈 → 검색 조건 확인 → 검색 결과)과 구급대원 업무 흐름에 맞게 보여준다.
// - Pre-KTAS: 구급대원이 고른 값과 평가 시각만 기록·표시한다 (순위 반영 없음, AI가 정하지 않음).
// - 결과 카드: 공공데이터(병원 입력값)와 '이번 환자 수용 확인'(직접 연락 결과)을 나눠 보여준다.
// - 카드 넘기기는 버튼(이전/다음)으로도 할 수 있다 (스와이프만으로 조작하지 않게).
(() => {
  const $ = selector => document.querySelector(selector);
  const Case = window.medinaviCase;
  const icon = name => '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
  const origin = () => (typeof currentLocation === "undefined" ? null : currentLocation);   // map.js가 관리하는 출발지
  const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  // ---- Pre-KTAS (구급대원 평가값) -------------------------------------------
  const ktasNames = {1: "소생", 2: "긴급", 3: "응급", 4: "준응급", 5: "비응급"};
  const ktasButtons = [...document.querySelectorAll(".ktas button")];
  function renderKtas() {
    const k = Case.ktasNow();
    for (const button of ktasButtons) button.setAttribute("aria-pressed", String(button.dataset.level === k?.level));
    $("#ktas-state").textContent = k
      ? k.level + "등급(" + ktasNames[k.level] + ") · 같은 버튼을 다시 누르면 미입력으로"
      : "미입력 · 고르지 않아도 검색할 수 있어요";
    $("#ktas-warn").hidden = !(k && Number(k.level) <= 2);
  }
  // 추가(표준지침 2023): 증상 추천(symptom-recommend.js)이 이 화면의 Pre-KTAS로 중증/경증 기준을 고른다.
  window.medinaviPreKtas = () => Case.ktasNow()?.level || "";
  for (const button of ktasButtons) {
    button.addEventListener("click", () => {
      const now = Case.ktasNow()?.level || "";
      Case.setKtas(now === button.dataset.level ? "" : button.dataset.level);   // 바꿀 때마다 시각과 함께 이력에 남긴다 (재평가)
    });
  }

  // ---- 출발지 (환자 위치) ---------------------------------------------------
  const locationButton = $("#my-location");
  const originLine = $("#origin-line");
  function originText() {
    const place = origin();
    if (!place) return "";
    return place.label ? "주소로 지정한 출발지: " + place.label : "기기 현재 위치를 출발지로 사용 중 (환자 위치와 다르면 주소로 지정하세요)";
  }
  function updateOrigin() {
    const status = $("#my-location-status").textContent;
    originLine.textContent = originText() || (status.includes("권한") || status.includes("못") || status.includes("초과")
      ? "기기 위치를 못 가져왔어요. 위 칸에 주소를 입력하세요"
      : "기기 위치 확인 중… (거부하면 위 칸에 주소를 입력하세요)");
    $("#origin-dot").dataset.on = String(Boolean(origin()));
    // 현재 출발지는 별도 상자 없이 주소 칸 안에 보여 준다 (입력 중에는 건드리지 않음).
    const input = $("#origin-query");
    const place = origin();
    if (document.activeElement !== input) {
      if (place?.label) { input.value = place.label; delete input.dataset.auto; }
      else if (place) showGpsAddress(place);
      else if (input.dataset.auto) { input.value = ""; delete input.dataset.auto; }
    }
    input.placeholder = "주소를 입력해주세요.";
    const done = $("#origin-status");
    if (place?.label && done.textContent.startsWith("출발지를 지정했어요")) done.textContent = "";
    if (dialog.open) fillSummary();
  }
  // 기기 위치를 쓰면 주소 칸에 현재 위치를 보여 준다. 네이버 지도 SDK의 주소 변환(Reverse Geocoding)이
  // 켜져 있으면 도로명 주소로, 아니면 'GPS'로 표시한다. 좌표는 화면에만 쓰고 저장·로그하지 않는다.
  let gpsKey = "";
  function showGpsAddress(place) {
    const input = $("#origin-query");
    const key = place.latitude.toFixed(5) + "," + place.longitude.toFixed(5);
    if (gpsKey === key && input.dataset.auto) return;
    gpsKey = key;
    input.dataset.auto = "gps";
    input.value = "현재 위치 (GPS)";
    const service = window.naver?.maps?.Service;
    if (!service?.reverseGeocode) return;
    service.reverseGeocode({
      coords: new naver.maps.LatLng(place.latitude, place.longitude),
      orders: [service.OrderType.ROAD_ADDR, service.OrderType.ADDR].join(","),
    }, (status, response) => {
      const address = status === service.Status.OK ? (response?.v2?.address?.roadAddress || response?.v2?.address?.jibunAddress || "").replace(/\s+/g, " ").trim() : "";
      if (!address || gpsKey !== key || input.dataset.auto !== "gps" || document.activeElement === input) return;
      input.value = "현재 위치: " + address;
    });
  }
  // 자동으로 채운 현재 위치 글자는 칸을 누르면 전체 선택돼 바로 새 주소를 입력할 수 있다.
  $("#origin-query").addEventListener("focus", event => { if (event.target.dataset.auto) event.target.select(); });
  $("#origin-query").addEventListener("input", event => { delete event.target.dataset.auto; });
  // 자동 표시 글자 그대로 '주소 검색'을 누르면 검색하지 않고 입력을 안내한다.
  $("#origin-search").addEventListener("submit", event => {
    const input = $("#origin-query");
    if (!input.dataset.auto) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.focus();
    $("#origin-status").textContent = "지금은 현재 위치를 쓰고 있어요. 다른 출발지는 주소를 입력한 뒤 검색하세요.";
  }, true);

  $("#use-location").addEventListener("click", () => {
    if (locationButton.disabled) originLine.textContent = "지도를 준비하고 있어요. 잠시 후 다시 눌러 주세요.";
    else locationButton.click();
  });
  const originWatch = new MutationObserver(updateOrigin);
  for (const id of ["#my-location-status", "#route-info", "#status"]) originWatch.observe($(id), {childList: true, characterData: true, subtree: true});
  // 조건 확인 시트 안에서 출발지 주소를 다시 정한다 (홈으로 돌아가지 않음, 입력한 조건 유지).
  // 서버의 주소 검색(/api/geocode)과 map.js의 setAddressOrigin을 그대로 쓴다.
  const inline = $("#origin-inline");
  const q2 = $("#origin-q2");
  const q2Status = $("#origin-q2-status");
  const q2Results = $("#origin-q2-results");
  $("#origin-reset").addEventListener("click", event => {
    inline.hidden = !inline.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!inline.hidden));
    if (!inline.hidden) q2.focus();
  });
  let q2Request = null;
  async function searchInline() {
    const query = q2.value.trim();
    if (!query) { q2Status.textContent = "주소를 입력해주세요."; q2.focus(); return; }
    q2Request?.abort();
    const controller = new AbortController();
    q2Request = controller;
    q2Results.replaceChildren();
    q2Status.textContent = "주소를 찾고 있어요.";
    try {
      const response = await fetch("/api/geocode?query=" + encodeURIComponent(query), {signal: controller.signal});
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "주소 검색에 실패했어요.");
      const list = body?.results || [];
      q2Status.textContent = list.length ? "출발지로 쓸 주소를 고르세요." : "찾은 주소가 없어요. 도로명과 건물번호로 다시 입력해 주세요.";
      for (const item of list) {
        const label = item.road_address || item.jibun_address;
        const li = document.createElement("li");
        const pick = document.createElement("button");
        pick.type = "button";
        pick.textContent = label;
        pick.addEventListener("click", () => {
          if (typeof window.setAddressOrigin !== "function") { q2Status.textContent = "지도를 준비하고 있어요. 잠시 후 다시 골라 주세요."; return; }
          window.setAddressOrigin(item.latitude, item.longitude, label);
          q2Results.replaceChildren();
          q2.value = "";
          inline.hidden = true;
          $("#origin-reset").setAttribute("aria-expanded", "false");
          q2Status.textContent = "";
          setTimeout(() => { updateOrigin(); fillSummary(); });
          Case.toast("출발지를 바꿨어요: " + label);
        });
        li.append(pick);
        q2Results.append(li);
      }
    } catch (error) {
      if (error.name !== "AbortError") q2Status.textContent = error.message || "주소 검색에 실패했어요.";
    }
  }
  $("#origin-q2-go").addEventListener("click", searchInline);
  q2.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchInline(); } });
  document.addEventListener("originchange", () => setTimeout(updateOrigin));

  // 증상 분류 중에는 [검색] 버튼 글자를 진행 문구로 바꾼다. 버튼 아래 줄(#symptom-status)은 오류 안내에만 쓴다.
  const searchButton = $("#symptom-button");
  const searchStatus = $("#symptom-status");
  const searchLabelHtml = searchButton.innerHTML;
  const BUSY_TEXT = "증상을 분류하고 있어요.";
  function syncSearchButton() {
    const busy = searchButton.disabled;
    searchButton.classList.toggle("busy", busy);
    searchButton.setAttribute("aria-busy", String(busy));
    searchButton.innerHTML = busy ? '<span class="spin" aria-hidden="true"></span>' + BUSY_TEXT : searchLabelHtml;
    searchStatus.classList.toggle("sr", searchStatus.textContent.trim() === BUSY_TEXT);
  }
  new MutationObserver(syncSearchButton).observe(searchButton, {attributes: true, attributeFilter: ["disabled"]});
  new MutationObserver(syncSearchButton).observe(searchStatus, {childList: true, characterData: true, subtree: true});

  // 오프라인 안내: 새 검색·병상 조회가 실패할 수 있음을 알리고, 작업 건 기록은 그대로임을 알린다.
  const offline = $("#offline");
  const updateOnline = () => { offline.hidden = navigator.onLine !== false; };
  addEventListener("online", updateOnline);
  addEventListener("offline", updateOnline);
  updateOnline();

  // ---- ② 검색 조건 확인 시트 (AI 해석값 / 직접 입력값 구분) -----------------
  const dialog = $("#symptom-confirm");
  const edit = $("#cond-edit");
  const editToggle = $("#cond-edit-toggle");
  const category1 = $("#confirm-category");
  const category2 = $("#confirm-category2");
  const minutes = $("#rec-minutes");
  const type = $("#rec-type");
  const child = $("#confirm-child");
  const ageInput = $("#confirm-age");
  const ageUnit = $("#confirm-age-unit");
  const ageKey = () => (ageInput?.value || "") + (ageUnit?.value || "");
  let aiValues = null;   // 시트가 열릴 때 AI가 채운 값 (사용자가 바꾸면 '직접 수정'으로 표시)
  // AI가 이동시간을 실제로 정했는지 알기 위해 증상 분류 응답에서 max_minutes만 기억한다 (원본 코드는 그대로 둠).
  let aiMinutes = null;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (resource, init) => {
    const response = await originalFetch(resource, init);
    if (String(resource).includes("/api/symptom/parse")) {
      aiMinutes = null;
      response.clone().json().then(body => { aiMinutes = body?.max_minutes ?? null; }).catch(() => {});
    }
    return response;
  };
  const tag = (kind, label) => ' <span class="tag ' + kind + '">' + label + '</span>';
  function categoryLabel() {
    const first = category1.selectedOptions[0]?.text || "-";
    const second = category2.value && category2.value !== category1.value ? category2.selectedOptions[0]?.text : "";
    return second ? (category1.value === "unclear" ? second : first + " + " + second) : first;
  }
  function fillSummary() {
    const place = origin();
    $("#sum-origin").innerHTML = esc(place ? (place.label || "기기 현재 위치") : "위치 확인 전") + tag("user", place?.label ? "주소" : "기기");
    const sameCategory = aiValues && aiValues.c1 === category1.value && aiValues.c2 === category2.value && aiValues.child === child.checked;
    $("#sum-category").innerHTML = esc(categoryLabel() + (child.checked ? " · 소아" : "")) + (aiValues ? (sameCategory ? tag("ai", "AI 해석") : tag("user", "직접 수정")) : tag("user", "직접 선택"));
    const sameMinutes = aiValues && aiValues.min === minutes.value;
    $("#sum-minutes").innerHTML = esc((minutes.value || "-") + "분 이내") + (sameMinutes ? (aiValues.minFromAi ? tag("ai", "AI 해석") : tag("user", "기본값")) : tag("user", "직접 수정"));
    const k = Case.ktasNow();
    // 표준지침(2023) 적용 기준: 분류·Pre-KTAS·나이·확인 항목으로 symptom-recommend.js가 정한 값을 보여준다.
    const guide = window.medinaviRecommend?.summary?.();
    // 기관 등급은 지침이 정한다. '기관 유형 더 좁히기'를 고르면 그 유형만 본다.
    $("#sum-type").innerHTML = guide
      ? esc(guide.level) + (type.value ? esc(" · " + type.value + "만") + tag("user", "직접 선택") : tag("dev", "지침 자동"))
      : esc(type.value || "제한 없음") + tag("user", type.value ? "직접 선택" : "필요하면 수정");
    // 평가 시각은 화면에 보이지 않고 작업 건 기록·전달 요약에만 남긴다.
    const severity = guide && !guide.fixed ? (guide.severity === "severe" ? " → 중증 기준" : " → 경증 기준") : "";
    $("#sum-ktas").innerHTML = esc((k ? k.level + "등급 (" + ktasNames[k.level] + ")" : "미입력") + severity) + tag("user", "구급대원 입력");
    $("#sum-ktas-warn").hidden = !(k && Number(k.level) <= 2);
    // 나이: AI가 채운 값 그대로면 'AI 해석', 바꿨으면 '직접 수정', 비어 있으면 '모르면 비워 둠'
    if (guide) {
      const sameAge = aiValues && aiValues.age === ageKey();
      $("#sum-age").innerHTML = esc(guide.ageText) + (guide.ageMonths == null
        ? tag("user", child.checked ? "소아로 보기" : "모르면 비워 둠")
        : sameAge ? tag("ai", "AI 해석") : tag("user", "직접 입력"));
      $("#sum-guide").hidden = false;
      $("#sum-guide-main").textContent = guide.guides.map(item => (guide.guides.length > 1 ? item.label + ": " : "") + item.title).join(" / ");
      $("#sum-guide-src").textContent = [...new Set(guide.guides.map(item => item.source).filter(Boolean))].join(" · ")
        + (guide.guides.length > 1 ? " · 두 분류 조건을 모두 보고, 기관 등급은 더 높은 쪽" : "");
      $("#flag-wrap").hidden = !guide.flags.length;
      const exclusions = guide.guides.filter(item => item.excluded).map(item => item.exclusion);
      $("#sum-guide-warn").hidden = !exclusions.length;
      $("#sum-guide-warn").textContent = exclusions.join(" ");
    }
  }
  // 확인창 값(분류·Pre-KTAS·나이·확인 항목)이 바뀌어 적용 기준이 다시 정해지면 요약도 다시 그린다.
  document.addEventListener("medinavi-guide-change", () => { if (dialog.open) fillSummary(); });
  function setEdit(open) {
    edit.hidden = !open;
    editToggle.textContent = open ? "수정 닫기" : "조건 수정";
    editToggle.setAttribute("aria-expanded", String(open));
  }
  editToggle.addEventListener("click", () => setEdit(edit.hidden));
  for (const control of [category1, category2, minutes, type, child, ageInput, ageUnit].filter(Boolean)) {
    control.addEventListener("input", fillSummary);
    control.addEventListener("change", fillSummary);
  }
  new MutationObserver(() => {
    if (!dialog.open) return;
    setEdit(false);
    // symptom-recommend.js가 값을 채운 직후의 상태를 'AI 해석값'으로 기억한다.
    setTimeout(() => {
      const failed = $("#symptom-note").textContent.includes("직접");
      aiValues = failed ? null : {c1: category1.value, c2: category2.value, child: child.checked, min: minutes.value, minFromAi: aiMinutes != null && String(aiMinutes) === minutes.value, age: ageKey()};
      if (failed) setEdit(true);   // AI가 실패하면 직접 고르도록 입력칸을 펼친다
      fillSummary();
    });
  }).observe(dialog, {attributes: true, attributeFilter: ["open"]});
  let searchLabel = "";
  $("#symptom-go").addEventListener("click", () => {
    searchLabel = categoryLabel() + (child.checked ? " · 소아" : "");
    const sameCategory = aiValues && aiValues.c1 === category1.value && aiValues.c2 === category2.value;
    Case.setConditions({origin: origin()?.label || (origin() ? "기기 현재 위치" : ""), category: searchLabel, aiInterpreted: Boolean(sameCategory)});
  }, {capture: true});

  // ---- 화면 전환 (브라우저 뒤로가기 = 조건 입력으로) --------------------------
  const more = $("#more");
  const moreToggle = $("#more-toggle");
  function setView(view, push = true) {
    const toResults = view === "results";
    if (toResults === document.body.classList.contains("results")) return;
    document.body.classList.toggle("results", toResults);
    if (toResults && push) history.pushState({medinavi: "results"}, "");
    window.scrollTo(0, 0);
  }
  window.addEventListener("popstate", () => setView("home", false));
  $("#results-back").addEventListener("click", () => (history.state?.medinavi === "results" ? history.back() : setView("home")));
  function setMore(open) {
    more.hidden = !open;
    document.body.classList.toggle("sheet-open", open);
    moreToggle.setAttribute("aria-expanded", String(open));
    moreToggle.textContent = open ? "지도 보기 ▾" : "전체 목록·상세 ▴";
    // 카드 안의 같은 버튼도 맞춘다 (이송 후보 추가 자리에 둠).
    for (const button of document.querySelectorAll('.rcard [data-act="more"]')) {
      button.setAttribute("aria-expanded", String(open));
      button.lastChild.textContent = open ? "지도 보기 ▾" : "전체 목록·상세 ▴";
    }
  }
  moreToggle.addEventListener("click", () => setMore(more.hidden));
  // 상단 '목록' = 추천 목록 보기로 (추천 목록이 없으면 전체 목록·상세를 연다)
  $("#list-open").addEventListener("click", () => {
    if (!$("#pick").hidden) { setMore(false); setListMode(true); $("#result-sheet").scrollTop = 0; return; }
    setMore(true);
    $("#recommend-area").hidden ? null : $("#recommend-results").scrollIntoView({behavior: smooth(), block: "start"});
  });

  // 지도를 못 불러오면 지도를 숨기고 목록으로 계속 일할 수 있게 한다.
  new MutationObserver(() => {
    const failed = /지도를 (불러오지|표시하지) 못|지도.*실패/.test($("#status").textContent);
    document.body.classList.toggle("map-failed", failed);
    if (failed) setMore(true);
  }).observe($("#status"), {childList: true, characterData: true, subtree: true});

  // 필터·메뉴 시트
  const filterSheet = $("#filter-sheet");
  const menuSheet = $("#menu-sheet");
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => button.closest("dialog").close());
  $("#filter-open").addEventListener("click", () => filterSheet.showModal());
  $("#menu-open").addEventListener("click", () => menuSheet.showModal());
  $("#menu-filter").addEventListener("click", () => { menuSheet.close(); filterSheet.showModal(); });
  $("#menu-case").addEventListener("click", () => { menuSheet.close(); Case.openCase(); });
  $("#menu-map").addEventListener("click", () => {
    menuSheet.close();
    source = "map";
    renderCards();
    setView("results");
    $("#all").click();
  });


  // ---- 추가(표준지침 2023): 결과 위 적용 기준 배너와 경고 -------------------
  const banner = $("#guide-banner");
  document.addEventListener("medinavi-recommend-done", event => {
    const result = event.detail;
    if (!banner || !result) return;
    const head = result.guides.map(item => item.title).join(" / ");
    $("#guide-banner-main").textContent = head + (result.severityText ? " · " + result.severityText.replace(/ 기준$/, "") : "") + " · " + result.ageText;
    const notes = $("#guide-banner-notes");
    notes.replaceChildren();
    for (const text of [...result.guides.map(item => item.label + ": " + item.title + (item.source ? " (" + item.source + ")" : "")), ...result.notes,
      "조건은 맞지만 지침 등급보다 낮은 가까운 기관은 '의료지도 필요'로 따로 보여줘요."]) {
      const li = document.createElement("li");
      li.textContent = text;
      notes.append(li);
    }
    const warn = [result.helicopter, ...result.exclusions].filter(Boolean).join(" ");
    $("#guide-banner-warn").hidden = !warn;
    $("#guide-banner-warn").textContent = warn;
    banner.hidden = false;
  });
  // 조건 검색이나 새 추천을 시작하면 이전 기준 배너를 숨긴다.
  document.addEventListener("medinavi-search", () => { if (banner) banner.hidden = true; });

  // ---- ③ 결과 카드 --------------------------------------------------------
  const track = $("#card-track");
  const count = $("#card-count");
  const sub = $("#results-sub");
  const recommendArea = $("#recommend-area");
  const recommendList = $("#recommend-results");
  const recommendStatus = $("#recommend-status");
  const conditionList = $("#search-results");
  let source = "";          // recommend | condition | map
  let quiet = false;        // 카드 넘기기로 선택할 때는 상세 패널을 펼치지 않는다
  let shown = 0;

  const hospitalOf = id => window.medinaviData?.items?.find(hospital => hospital.hpid === id) || null;
  const listOf = () => (source === "recommend" ? recommendList : source === "condition" ? conditionList : null);
  const MAX_CARDS = 5;
  // 순위에 들지 못한 기관도 빼지 않고 이름표를 달아 5장까지 채운다 (교수님 피드백: 확인 필요 기관은 아래에 표시).
  const TIERS = [
    {id: "guided", list: "#recommend-guided-list", label: "의료지도 필요", cls: "t-guided"},
    {id: "partial", list: "#recommend-partial-list", label: "일부 조건 일치", cls: "t-partial"},
    {id: "unknown", list: "#recommend-unknown-list", label: "조건 확인 필요", cls: "t-unknown"},
    {id: "capacity", list: "#recommend-capacity-list", label: "지금 수용 어려움", cls: "t-busy"},
  ];
  function supplementEntries(have) {
    const out = [];
    const seen = new Set(have.map(entry => entry.hpid));
    for (const tier of TIERS) {
      for (const item of $(tier.list)?.children || []) {
        if (have.length + out.length >= MAX_CARDS) return out;
        const button = item.querySelector("button[data-hpid]");
        // call.js가 붙인 전화 버튼(<a>) 글자는 빼고 읽는다.
        const text = button ? button.textContent : [...item.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("");
        const name = text.split(" · ")[0].trim();
        // '조건 확인 필요' 목록은 기관 ID가 없어 이름으로 찾는다. 같은 이름이 여러 곳이면 넣지 않는다.
        const matches = button ? [hospitalOf(button.dataset.hpid)].filter(Boolean) : (window.medinaviData?.items || []).filter(h => h.dutyName === name);
        if (matches.length !== 1 || seen.has(matches[0].hpid)) continue;
        seen.add(matches[0].hpid);
        out.push({hpid: matches[0].hpid, hospital: matches[0], minutes: text.match(/약 (\d+)분/)?.[1], km: "", first: text,
          tier, reason: text.split(" — ").slice(1).join(" — ").trim()});
      }
    }
    return out;
  }
  function entries() {
    const list = listOf();
    const ranked = list ? [...list.children].map(item => {
      const main = item.querySelector(":scope > button[data-hpid]");
      if (!main) return null;
      const first = main.textContent.split("\n")[0];
      return {hpid: main.dataset.hpid, hospital: hospitalOf(main.dataset.hpid) || {}, minutes: first.match(/약 (\d+)분/)?.[1], km: first.match(/([\d.]+)km/)?.[1], first};
    }).filter(Boolean) : [];
    return source === "recommend" ? ranked.concat(supplementEntries(ranked)) : ranked;
  }

  function cardOf(entry, index) {
    const {hpid, hospital, minutes: time, km, first} = entry;
    const name = hospital.dutyName || first;
    const phone = Case.phoneOf(hospital);
    const realtime = window.medinaviRealtime?.summary?.(hpid) || "";
    const notice = window.medinaviRealtime?.noticeText?.(hpid) || "";
    const contact = Case.current(hpid);
    const info = Case.STATUS[contact?.status || "none"];
    const isCandidate = Case.isCandidate(hpid);
    // 이번 검색 조건 판정(공공데이터): 개수로 요약하고, 조건별 근거는 펼쳐서 본다. 확인 필요·불일치는 항상 보인다.
    const judge = window.medinaviJudge;
    const checks = (judge?.checksFor?.(hpid) || []).filter(check => check.kind !== "reference");
    const n = status => checks.filter(check => check.status === status).length;
    const condLine = checks.length
      ? '<li class="' + (n("불가") ? "st-bad" : n("확인 필요") ? "st-wait" : "st-ok") + '"><span class="mark" aria-hidden="true">' + (n("불가") ? "✖" : n("확인 필요") ? "?" : "✓") + '</span><span>' +
          '조건 일치 ' + n("가능") + '/' + checks.length + (n("확인 필요") ? ' · 확인 필요 ' + n("확인 필요") : '') + (n("불가") ? ' · 불일치 ' + n("불가") : '') +
          '<details class="why"><summary>조건별 근거</summary><ul>' + checks.map(check => '<li>' + esc(judge.checkText(check)) + '</li>').join("") + '</ul></details></span></li>'
      : source === "condition"
        ? '<li class="st-ok"><span class="mark" aria-hidden="true">✓</span><span>고른 조건(기관 유형·과목·질환): 조회 정보상 일치</span></li>'
        : '<li class="st-unk"><span class="mark" aria-hidden="true">?</span><span>조건별 판정 정보 없음</span></li>';
    const tier = entry.tier;
    const rankBadge = tier
      ? '<span class="rank ' + tier.cls + '">' + (index + 1) + ' 참고<small>' + tier.label + '</small></span>'
      : '<span class="rank">' + (index + 1) + '<small>이동시간순</small></span>';
    // 의료지도 필요: 조건은 맞지만 지침 등급보다 낮은 기관 (표준지침: 의료지도를 받으면 가까운 기관으로 이송 가능)
    const guidedText = tier?.id === "guided" ? (entry.reason || "").replace(/ · 의료지도 필요/, "") : "";
    const tierLine = tier?.id === "guided"
      ? '<li class="st-wait"><span class="mark" aria-hidden="true">△</span><span>지침 등급보다 낮은 기관' + (guidedText ? ': ' + esc(guidedText) : '') +
          ' · 의료지도를 받으면 이송할 수 있어요</span></li>'
      : tier
      ? '<li class="' + (tier.id === "capacity" ? "st-bad" : "st-wait") + '"><span class="mark" aria-hidden="true">' + (tier.id === "capacity" ? "✖" : "?") + '</span><span>' +
          tier.label + (entry.reason ? ': ' + esc(entry.reason) : '') + ' · 병원에 직접 확인 필요</span></li>'
      : condLine;
    return '<article class="rcard' + (tier ? ' is-ref' : '') + '" data-index="' + index + '" data-hpid="' + esc(hpid) + '" data-name="' + esc(name) + '" data-tier="' + (tier?.id || "") + '" aria-label="' + (index + 1) + '번째 기관' + (tier ? ', ' + tier.label : '') + '">' +
      '<button type="button" class="rcard-top" data-act="route" aria-label="' + esc(name) + ' 경로 보기">' + rankBadge +
      '<span><span class="rname">' + esc(name) + '</span>' + (isCandidate ? '<span class="cand-flag">이송 후보</span>' : '') +
      '<span class="rtype">' + esc(hospital.dutyEmclsName || "기관 구분 확인 필요") + '</span></span><span class="chev">' + icon("next") + '</span></button>' +
      (time ? '<p class="rtime">' + icon("car") + '예상 ' + time + '분' + (km ? ' · ' + km + 'km' : '') + ' <small>일반 자동차 기준</small></p>' : '<p class="rtime">' + icon("car") + '이동시간 확인 필요</p>') +
      '<div class="layer"><h4>공공데이터 · 병원 입력값 (실제와 다를 수 있음)</h4><ul>' +
        tierLine +
        (realtime ? '<li><span class="mark" aria-hidden="true">▣</span><span>' + esc(realtime) + '</span></li>'
                  : '<li class="st-unk"><span class="mark" aria-hidden="true">?</span><span>병상 정보 미제공 (0이나 불가가 아님)</span></li>') +
        (notice ? '<li class="st-wait"><span class="mark" aria-hidden="true">!</span><span>' + esc(notice) + '</span></li>' : '') +
      '</ul></div>' +
      // [보류 2026-11-19] '이번 환자 수용 확인' 칸은 카드에서 뺐다. 연락 기록 기능(결과 기록·작업 건)은 그대로 동작한다.
      // 나중에 결과 화면에서 병원 이름 옆 작은 표시(연락한 병원만)로 다시 넣을지 정한다. (contact·info 값은 그때 쓴다)
      '<div class="ractions">' +
        (phone ? '<a class="btn teal" data-act="call" href="tel:' + esc(phone.number.replace(/-/g, "")) + '" aria-label="' + phone.kind + ' 전화 ' + esc(phone.number) + ' (전화 앱 열기)">' + icon("phone") + phone.kind + ' 전화</a>'
               : '<a class="btn" aria-disabled="true">' + icon("phone") + '등록 번호 없음</a>') +
        '<button type="button" class="btn small" data-act="more" aria-controls="more" aria-expanded="' + !more.hidden + '">' + icon("list") + (more.hidden ? '전체 목록·상세 ▴' : '지도 보기 ▾') + '</button>' +
      '</div></article>';
  }

  function renderCards(keep = false) {
    const list = entries();
    Case.setResults(list.map(entry => ({hpid: entry.hpid, name: entry.hospital.dutyName, minutes: entry.minutes, km: entry.km})));
    if (!keep) shown = 0;
    if (source === "map") {
      sub.textContent = "강원 응급의료기관 " + (window.medinaviData?.items?.length || "") + "곳 · 핀을 누르면 상세";
      count.textContent = "";
      renderPick([]);
      track.innerHTML = '<p class="empty-card">지도에서 병원 핀을 누르면 상세 정보가 열려요.</p>';
      return;
    }
    track.innerHTML = list.map(cardOf).join("");
    renderPick(list);
    // 결과(기관 구성)가 새로 바뀌었을 때만 추천 목록 보기로 시작한다. 같은 결과를 다시 그릴 때는 지금 보기를 유지한다.
    const listKey = source + ":" + list.map(entry => entry.hpid).join(",");
    if (!keep && listKey !== lastListKey) { lastListKey = listKey; setListMode(list.length > 0); }
    const busy = source === "recommend" && /있어요\.$/.test(recommendStatus.textContent);   // "…확인하고 있어요."
    const rankedCount = list.filter(entry => !entry.tier).length;
    const refCount = list.length - rankedCount;
    if (list.length) {
      sub.textContent = (source === "recommend" ? "필수 조건 충족 " : "조건 일치 ") + rankedCount + "곳" + (refCount ? " + 참고 " + refCount + "곳" : "") + " · 이동시간순 · " + (searchLabel && source === "recommend" ? searchLabel : "직접 검색");
      count.textContent = (shown + 1) + " / " + list.length;
      if (keep) track.scrollLeft = shown * track.clientWidth;
    } else if (busy || (source === "recommend" && !recommendStatus.textContent)) {
      sub.textContent = recommendStatus.textContent || "조건에 맞는 기관을 찾고 있어요.";
      count.textContent = "";
      track.innerHTML = '<p class="empty-card">' + esc(sub.textContent) + '</p>';
    } else {
      sub.textContent = "필수 조건을 모두 충족한 기관이 없어요.";
      count.textContent = "";
      track.innerHTML = '<p class="empty-card">' + esc(recommendStatus.textContent || "조건을 바꿔 다시 찾아 주세요.") +
        '<br><span class="note">조건은 자동으로 넓히지 않아요. 아래 \'확인 필요\'·\'지금 수용 어려움\' 목록을 보거나 조건을 직접 바꿔 주세요.</span></p>';
      setMore(true);
    }
    $("#card-prev").disabled = shown <= 0;
    $("#card-next").disabled = shown >= list.length - 1;
  }

  // ---- 추천 목록 보기 (결과 화면 기본) → 항목을 누르면 카드 + 상세 ----------------
  var lastListKey = "";   // renderCards가 먼저 정의돼 있어 var로 둔다

  // 지도 번호 핀: 선택하지 않은 번호 핀은 연두색으로 (선택된 핀만 짙은 녹색·크게).
  // 핀 모양은 hospital-route-view.js(원본)가 만들므로, 그 색(#126c60)만 바꿔 그리도록 지도 핀의 setIcon을 감싼다.
  const UNSELECTED = 'fill="#126c60"';
  const LIGHT = 'fill="#7cb342"';
  (function patchPins(tries) {
    const proto = window.naver?.maps?.Marker?.prototype;
    if (!proto) { if (tries < 100) setTimeout(() => patchPins(tries + 1), 200); return; }
    if (proto.__medinaviLight) return;
    const setIcon = proto.setIcon;
    proto.setIcon = function (icon) {
      if (icon && typeof icon.content === "string" && icon.content.includes(UNSELECTED)) icon = {...icon, content: icon.content.replace(UNSELECTED, LIGHT)};
      return setIcon.call(this, icon);
    };
    proto.__medinaviLight = true;
    // 검색 직후 1번 경로를 그릴 때 지도가 경로에만 확대되지 않도록, 그 한 번은 결과 5곳 + 출발지가 모두 보이게 맞춘다.
    const mapProto = window.naver.maps.Map.prototype;
    const fitBounds = mapProto.fitBounds;
    mapProto.fitBounds = function (bounds, margin) {
      if (fitAllNext) {
        fitAllNext = false;
        const all = allResultsBounds();
        if (all) return fitBounds.call(this, all, {top: 60, right: 60, bottom: 50, left: 50});
      }
      return fitBounds.call(this, bounds, margin);
    };
  })(0);
  var fitAllNext = false;
  function allResultsBounds() {
    const bounds = new naver.maps.LatLngBounds();
    let count = 0;
    for (const card of track.children) {
      const hospital = hospitalOf(card.dataset?.hpid);
      const lat = Number(hospital?.wgs84Lat), lon = Number(hospital?.wgs84Lon);
      if (hospital && Number.isFinite(lat) && Number.isFinite(lon) && String(hospital.wgs84Lat).trim()) { bounds.extend(new naver.maps.LatLng(lat, lon)); count++; }
    }
    const place = origin();
    if (place) bounds.extend(new naver.maps.LatLng(place.latitude, place.longitude));
    return count ? bounds : null;
  }
  const pickBox = $("#pick");
  const pickList = $("#pick-list");
  function setListMode(on) {
    document.body.classList.toggle("list-mode", Boolean(on) && !pickBox.hidden);
    requestAnimationFrame(fitTrack);
  }
  function condSummary(hpid) {
    const judge = window.medinaviJudge;
    const checks = (judge?.checksFor?.(hpid) || []).filter(check => check.kind !== "reference");
    if (!checks.length) return source === "condition" ? {text: "고른 조건: 조회 정보상 일치", cls: "p-ok"} : null;
    const n = status => checks.filter(check => check.status === status).length;
    return {text: "조건 일치 " + n("가능") + "/" + checks.length + (n("확인 필요") ? " · 확인 필요 " + n("확인 필요") : "") + (n("불가") ? " · 불일치 " + n("불가") : ""),
            cls: n("불가") ? "p-bad" : n("확인 필요") ? "p-wait" : "p-ok"};
  }
  function renderPick(list) {
    if (!list.length || source === "map") { pickBox.hidden = true; document.body.classList.remove("list-mode"); return; }
    pickBox.hidden = false;
    const refs = list.filter(entry => entry.tier).length;
    $("#pick-note").textContent = "(" + (source === "recommend" ? "필수 조건 충족" : "조건 일치") + " · 이동시간순" + (refs ? " · 참고 " + refs + "곳" : "") + ")";
    pickList.innerHTML = list.map((entry, index) => {
      const {hpid, hospital, minutes: time, km, tier, reason} = entry;
      const cond = tier ? {text: tier.label + (reason ? ": " + reason : ""), cls: tier.id === "capacity" ? "p-bad" : "p-wait"} : condSummary(hpid);
      const realtime = window.medinaviRealtime?.summary?.(hpid) || "";
      const notice = window.medinaviRealtime?.noticeText?.(hpid) || "";
      return '<li><button type="button" data-i="' + index + '"' + (tier ? ' data-tier="' + tier.id + '"' : '') + '>' +
        '<span class="p-name"><span class="p-rank">' + (index + 1) + '.</span> ' + esc(hospital.dutyName || entry.first) + (tier ? ' <span class="note">(참고)</span>' : '') + '</span>' +
        '<span class="p-sub">' + esc(hospital.dutyEmclsName || "기관 구분 확인 필요") + (time ? ' · 약 ' + time + '분' : '') + (km ? ' · ' + km + 'km' : '') + '</span>' +
        (cond ? '<span class="' + cond.cls + '">' + esc(cond.text) + '</span>' : '') +
        (realtime ? '<span>' + esc(realtime) + '</span>' : '<span class="p-sub">병상 정보 미제공 (0이나 불가가 아님)</span>') +
        (notice ? '<span class="p-wait">' + esc(notice) + '</span>' : '') +
        '</button></li>';
    }).join("");
  }
  function openCard(index, withDetail) {
    const card = track.children[index];
    if (!card?.dataset?.hpid) return;
    setListMode(false);
    shown = index;
    track.scrollLeft = index * track.clientWidth;
    count.textContent = (index + 1) + " / " + track.children.length;
    $("#card-prev").disabled = index <= 0;
    $("#card-next").disabled = index >= track.children.length - 1;
    requestAnimationFrame(fitTrack);
    pressOriginal(card.dataset.hpid, withDetail);
    // 카드가 맨 위에 보이고 그 아래로 상세가 이어지게 한다 (상세로 건너뛰지 않음).
    for (const delay of [150, 500]) setTimeout(() => { $("#result-sheet").scrollTop = 0; }, delay);
  }
  pickList.addEventListener("click", event => {
    const button = event.target.closest("button[data-i]");
    if (button) openCard(Number(button.dataset.i), true);
  });
  $("#back-list").addEventListener("click", () => { setMore(false); setListMode(true); $("#result-sheet").scrollTop = 0; });

  // 카드 버튼: 경로 = 원본 목록 버튼을 눌러 지도에 경로 표시, 이름 = 상세 펼치기
  function pressOriginal(hpid, showDetail) {
    const selector = 'button[data-hpid="' + CSS.escape(hpid) + '"]';
    const main = listOf()?.querySelector(selector) || $("#recommend-area").querySelector(selector);
    if (!main) {
      // '조건 확인 필요' 기관은 원본 목록에 버튼이 없어 상세를 바로 연다 (경로는 상세에서 조회).
      const hospital = hospitalOf(hpid);
      if (!hospital || typeof window.showHospitalDetail !== "function") return;
      quiet = !showDetail;
      window.showHospitalDetail(hospital, window.medinaviData);
      setTimeout(() => { quiet = false; });
      if (showDetail) { setMore(true); setTimeout(() => $("#hospital-detail").scrollIntoView({behavior: smooth(), block: "start"}), 50); }
      return;
    }
    quiet = !showDetail;
    main.click();
    setTimeout(() => { quiet = false; });   // 상세 패널 감시(MutationObserver)가 끝난 뒤 푼다
    if (showDetail) {
      setMore(true);
      setTimeout(() => $("#hospital-detail").scrollIntoView({behavior: smooth(), block: "start"}), 50);
    }
  }
  track.addEventListener("click", event => {
    const button = event.target.closest("[data-act]");
    const card = event.target.closest(".rcard");
    if (!button || !card) return;
    const {hpid, name} = card.dataset;
    const act = button.dataset.act;
    if (act === "more") setMore(more.hidden);
    else if (act === "call") Case.dialed(hpid, name);      // 전화 앱 열기만 기록 (통화·수용 확인 아님)
    else if (act === "record") Case.openContact(hpid, name);
    else if (act === "candidate") {
      if (Case.toggleCandidate(hpid, name) === false) {
        Case.toast("이송 후보는 최대 " + Case.MAX_CANDIDATES + "곳이에요. 작업 건에서 하나를 뺀 뒤 추가해 주세요.");
        return;
      }
      Case.toast(Case.isCandidate(hpid)
        ? name + "을 이송 후보에 추가했어요 (" + Case.candidateCount() + "/" + Case.MAX_CANDIDATES + "). 병원 배정·접수가 아니에요."
        : "이송 후보에서 뺐어요. 연락 기록은 그대로 남아요.");
    } else pressOriginal(hpid, act === "detail");
  });
  function go(index) {
    const card = track.children[index];
    if (!card) return;
    track.scrollTo({left: index * track.clientWidth, behavior: smooth()});
  }
  $("#card-prev").addEventListener("click", () => go(shown - 1));
  $("#card-next").addEventListener("click", () => go(shown + 1));
  // 옆으로 넘기면(또는 이전/다음) 그 병원을 지도에서 강조하고 경로를 보여준다 (검색 때 받은 경로를 다시 씀).
  let swipeTimer = null;
  track.addEventListener("scroll", () => {
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => {
      const index = Math.round(track.scrollLeft / (track.clientWidth || 1));
      if (index === shown || !track.children[index]?.dataset.hpid) return;
      shown = index;
      fitTrack();
      count.textContent = (shown + 1) + " / " + track.children.length;
      $("#card-prev").disabled = shown <= 0;
      $("#card-next").disabled = shown >= track.children.length - 1;
      pressOriginal(track.children[index].dataset.hpid, false);
    }, 150);
  });

  // 원본 결과가 바뀌면 카드를 다시 만든다 (항목이 하나씩 추가되므로 한 번에 모아서).
  let pending = 0;
  function refresh(from) {
    if (from) source = from;
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const same = (source + ":" + entries().map(entry => entry.hpid).join(",")) === lastListKey;
      renderCards(same);              // 같은 결과면 보던 카드·보기를 유지
      if (!same) track.scrollLeft = 0;
      pinAll(); autoRouteFirst(); fitTrack(); setTimeout(autoExplain, 300);
    });
  }
  // 카드 영역 높이를 지금 보이는 카드에 맞춘다 (긴 카드 때문에 아래 AI 설명이 밀려나지 않게).
  function fitTrack() {
    const card = track.children[shown] || track.children[0];
    track.style.height = card && card.classList.contains("rcard") ? (card.offsetHeight + 6) + "px" : "";   // 버튼 테두리가 잘리지 않게 여유 6px
  }
  new ResizeObserver(fitTrack).observe(track);
  track.addEventListener("toggle", () => requestAnimationFrame(fitTrack), true);   // '조건별 근거'를 펼치면 높이를 다시 맞춘다
  // 검색이 끝나면 AI 결과 설명을 자동으로 받는다 (같은 결과에서는 한 번만 · AI 호출 1회).
  let explainKey = "";
  function autoExplain() {
    if (source !== "recommend") return;
    const button = $("#explain-button");
    const key = [...track.children].map(card => card.dataset?.hpid).join(",");
    if (!key || key === explainKey || $("#explain-area").hidden || button.disabled) return;
    explainKey = key;
    button.click();
  }
  // 검색이 끝나면 1번 병원 경로를 바로 보여 준다 (같은 결과에서는 한 번만, 상세는 펼치지 않음).
  let autoKey = "";
  function autoRouteFirst() {
    const first = track.children[0]?.dataset?.hpid;
    if (!first) { autoKey = ""; return; }
    const key = source + ":" + [...track.children].map(card => card.dataset.hpid).join(",");
    if (key === autoKey) return;
    autoKey = key;
    fitAllNext = true;                 // 1번 경로를 그려도 화면은 5곳 전체가 보이게
    setTimeout(() => { fitAllNext = false; }, 8000);
    pressOriginal(first, false);
  }
  // 참고 카드(3~5번 등)도 지도에 같은 번호 핀으로 표시한다. 원본 핀 기능(showSearchResults)에 카드 순서대로 넘긴다.
  let pinnedKey = "";
  function pinAll() {
    if (source !== "recommend" || !window.hospitalRouteView || !window.naver?.maps) return;
    const list = entries();
    if (!list.some(entry => entry.tier)) { pinnedKey = ""; return; }
    const key = list.map(entry => entry.hpid).join(",");
    if (key === pinnedKey) return;   // 같은 결과로 다시 부르면 선택·경로가 풀리므로 한 번만
    pinnedKey = key;
    const view = window.hospitalRouteView;
    window.hospitalRouteView?.showSearchResults(list.map(entry => ({hospital: entry.hospital, route: entry.tier ? null : view.routeFor(entry.hpid)})));
  }
  new MutationObserver(() => {
    if (!recommendArea.hidden) {
      setMore(false);
      setView("results");
      refresh("recommend");
    } else if (source === "recommend") {
      // 출발지를 바꾸는 등으로 추천이 지워지면 조건 입력으로 돌아간다.
      source = "";
      if (document.body.classList.contains("results")) history.state?.medinavi === "results" ? history.back() : setView("home");
    }
  }).observe(recommendArea, {attributes: true, attributeFilter: ["hidden"]});
  new MutationObserver(() => { if (source === "recommend") refresh(); }).observe(recommendList, {childList: true});
  new MutationObserver(() => { if (source === "recommend") refresh(); }).observe(recommendStatus, {childList: true, characterData: true, subtree: true});
  new MutationObserver(() => {
    if (!conditionList.children.length) return;
    filterSheet.close();
    setMore(false);
    setView("results");
    refresh("condition");
  }).observe(conditionList, {childList: true});
  // 연락 기록·후보가 바뀌면 지금 보던 카드 위치를 유지한 채 다시 그린다.
  Case.onChange(() => { renderKtas(); if (source === "recommend" || source === "condition") { renderCards(true); fitTrack(); } if (dialog.open) fillSummary(); });

  // 지도 번호 핀을 누르면 아래 카드도 그 병원으로 넘긴다 (상세는 펼치지 않음).
  // map.js의 showHospitalDetail을 감싸기만 하고, 원래 동작(상세 채우기·경로 표시)은 그대로 실행한다.
  const originalDetail = window.showHospitalDetail;
  if (typeof originalDetail === "function") {
    window.showHospitalDetail = function (hospital) {
      const index = [...track.children].findIndex(card => card.dataset?.hpid === hospital?.hpid);
      const fromPin = !quiet && index >= 0 && document.body.classList.contains("results") && !more.contains(document.activeElement);
      if (fromPin) quiet = true;
      const result = originalDetail.apply(this, arguments);
      if (fromPin) {
        setTimeout(() => { quiet = false; });
        setListMode(false);   // 목록 보기 중이면 그 병원 카드로 바꾼다
        shown = index;
        fitTrack();
        track.scrollTo({left: index * track.clientWidth, behavior: smooth()});
        count.textContent = (index + 1) + " / " + track.children.length;
        $("#card-prev").disabled = index <= 0;
        $("#card-next").disabled = index >= track.children.length - 1;
      }
      return result;
    };
  }

  // 지도 핀·전체 목록에서 병원을 고르면 결과 화면에서 상세 정보를 펼친다.
  const detail = $("#hospital-detail");
  new MutationObserver(() => {
    if (detail.hidden || quiet) return;
    if (menuSheet.open) menuSheet.close();
    if (!document.body.classList.contains("results")) { if (!source) { source = "map"; renderCards(); } setView("results"); }
    setMore(true);
    setTimeout(() => detail.scrollIntoView({behavior: smooth(), block: "start"}), 50);
  }).observe(detail, {attributes: true, attributeFilter: ["hidden"]});

  renderKtas();
  updateOrigin();
})();
