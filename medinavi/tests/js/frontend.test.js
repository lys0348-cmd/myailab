// 화면(frontend/*.js) 시나리오 시험. 실제 브라우저 대신 가짜 화면·가짜 네이버 지도·가짜 서버 응답으로
// 페이지와 같은 순서로 스크립트를 불러와 주요 흐름을 확인한다.
// 실행 (medinavi 폴더에서):  node tests/js/frontend.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..", "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
// 화면 시험은 공통 스크립트를 예전 원본 화면(index_classic.html)의 요소로 돌린다.
// 기본 화면(index.html, 새 화면)은 같은 요소 id와 스크립트를 쓰는지 따로 검사한다.
const html = read("frontend/index_classic.html");
const mainHtml = read("frontend/index.html");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const scripts = [...html.matchAll(/<script src="\/static\/([^"?]+)/g)].map(match => "frontend/" + match[1]);
const hospitalsRaw = JSON.parse(read("data/hospitals.json").replace(/^﻿/, ""));
const rules = JSON.parse(read("data/recommendation_rules.json"));
const ILLNESS = ["[재관류중재술] 심근경색", "[재관류중재술] 뇌경색", "[뇌출혈수술] 거미막하출혈", "[뇌출혈수술] 거미막하출혈 외", "[대동맥응급] 흉부",
  "[대동맥응급] 복부", "[담낭담관질환] 담낭질환", "[담낭담관질환] 담도포함질환", "[복부응급수술] 비외상", "[장중첩/폐색] 영유아", "[응급내시경] 성인 위장관",
  "[응급내시경] 영유아 위장관", "[응급내시경] 성인 기관지", "[응급내시경] 영유아 기관지", "[저체중출생아] 집중치료", "[산부인과응급] 분만", "[산부인과응급] 산과수술",
  "[산부인과응급] 부인과수술", "[중증화상] 전문치료", "[사지접합] 수족지접합", "[사지접합] 수족지접합 외", "[응급투석] HD", "[응급투석] CRRT",
  "[정신과적응급] 폐쇄병동입원", "[안과적수술] 응급", "[영상의학혈관중재] 성인", "[영상의학혈관중재] 영유아"];

// 서버가 보내는 것과 같은 모양의 병원 목록 (진료과목 이름 묶기 포함)
function hospitalsResponse() {
  const data = JSON.parse(JSON.stringify(hospitalsRaw));
  for (const item of data.items) {
    if (item.departments) item.departments = [...new Set(item.departments.map(name => name === "구강안면외과" ? "구강악안면외과" : name))];
  }
  data.illness_types = ILLNESS;
  data.home_sido = "강원특별자치도";
  return data;
}

// 병원 순서(index)에 따라 정해지는 가짜 실시간 정보: 혼잡도·중증질환 상태가 골고루 나오게 한다.
function realtimeResponse(items, {minutesAgo = 4} = {}) {
  const updated = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const combos = [[15, 20], [6, 20], [2, 20], [0, 20], [-5, 20], [5, null]];
  const hospitals = {};
  items.forEach((item, index) => {
    if (index === 2) return;                          // 실시간 정보를 주지 않는 기관
    const [available, total] = combos[index % 6];
    const illness = ILLNESS.map(label => ({label, status: "확인 필요", note: ""}));
    illness[0].status = ["가능", "불가", "확인 필요"][index % 3];          // 심근경색
    illness[1].status = index % 3 === 0 ? "불가" : "가능";                   // 뇌경색: 심근경색 '가능' 병원은 불가
    illness[15].status = "가능";                                           // 분만
    hospitals[item.hpid] = {
      updated_at: updated, has_beds: true, has_illness: index !== 5, er_available: available, er_total: total,
      beds: [{label: "응급실 일반", available, total}, {label: "수술실", available: 3, total: null}],
      equipment: [{label: "CT", status: "가능"}, {label: "혈관촬영기", status: index % 2 ? "불가" : "가능"}],
      illness: index === 5 ? [] : illness,
    };
  });
  // 심근경색 '가능' 병원에는 관련 공지 1건과 이미 끝난 공지 1건을 붙인다.
  const notices = {};
  items.forEach((item, index) => {
    if (index === 2 || index % 3) return;
    notices[item.hpid] = [
      {kind: "중증질환", topic: "심근경색의 재관류중재술", department: "", illness: ILLNESS[0], text: "심장내과 사정으로 CAG 불가능",
       start: updated, end: new Date(Date.now() + 3600000).toISOString()},
      {kind: "응급실", topic: "응급실", department: "", illness: null, text: "끝난 공지", start: updated, end: new Date(Date.now() - 60000).toISOString()},
    ];
  });
  return {retrieved_at: updated, source: "시험", errors: [], hospitals, notices};
}

function createPage({symptom = null, realtimeFails = false, geocode = null, search = "", storage = new Map(), tweak = null} = {}) {
  const els = {};
  const docListeners = {};
  const markers = [];
  const fits = [];
  const routeRequests = [];
  const geoRequests = [];
  const symptomRequests = [];
  const explainRequests = [];
  const urlChanges = [];

  function element(id) {
    return {
      id, children: [], options: [], hidden: false, disabled: false, textContent: "", value: "", checked: false, open: false,
      dataset: {}, attrs: {}, style: {}, className: "", listeners: {}, onclick: null,
      classList: {set: new Set(), toggle(name, on) { on ? this.set.add(name) : this.set.delete(name); }, remove(name) { this.set.delete(name); }, contains(name) { return this.set.has(name); }},
      get valueAsNumber() { return Number(this.value); },
      add(option) { this.options.push(option); },
      append(...items) { for (const item of items) typeof item === "string" ? (this.textContent += item) : this.children.push(item); },
      replaceChildren() { this.children = []; if (this.options) this.options = this.options.slice(0, 1); },
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name]; },
      addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); },
      scrollIntoView() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
      click() { return this.fire("click"); },
      async fire(type) {
        if (type === "click" && this.onclick) await this.onclick();
        for (const listener of this.listeners[type] || []) await listener({preventDefault() {}});
      },
    };
  }
  for (const id of ids) els[id] = element(id);
  // 선택 칸은 첫 선택지(빈 값)를 가진 상태로 시작한다.
  for (const id of ["hospital-type", "department", "illness", "rec-type"]) els[id].options = [{value: ""}];
  els["search-button"].disabled = true;
  const badges = [element("badge1"), element("badge2"), element("badge3")];
  const buttonsIn = id => els[id].children.map(item => item.children[0]);

  const document = {
    querySelector: selector => selector.startsWith("#") ? els[selector.slice(1)] || null : null,
    querySelectorAll(selector) {
      if (selector === "nav button") return [els.all, els.plus, els.minus];
      if (selector === ".rules-badge") return badges;
      if (selector.includes("button[data-hpid]")) return [...buttonsIn("search-results"), ...buttonsIn("recommend-results")];
      throw new Error("시험 화면이 모르는 선택자: " + selector);
    },
    createElement: element,
    addEventListener(type, listener) { (docListeners[type] = docListeners[type] || []).push(listener); },
    dispatchEvent(event) { (docListeners[event.type] || []).forEach(listener => listener(event)); },
    visibilityState: "visible",
  };

  class LatLng { constructor(lat, lng) { this.lat = lat; this.lng = lng; } }
  class Bounds { constructor() { this.points = []; } extend(point) { this.points.push(point); } }
  class Marker {
    constructor(options) { Object.assign(this, options); this.icon = options.icon || "DEFAULT"; markers.push(this); }
    setIcon(icon) { this.icon = icon; } getIcon() { return this.icon; } setMap(map) { this.map = map; } setZIndex(z) { this.z = z; }
    getPosition() { return this.position; } setPosition(position) { this.position = position; } setTitle(title) { this.title = title; }
  }
  const naver = {maps: {
    Map: class { constructor() { this.zoom = 8; } fitBounds(bounds) { fits.push(bounds.points.length); } setCenter() {} setZoom(zoom) { this.zoom = zoom; } getZoom() { return this.zoom; } },
    LatLng, LatLngBounds: Bounds, Marker, Size: class { constructor(w, h) { this.w = w; this.h = h; } }, Point: class {},
    Polyline: class { constructor(options) { this.map = options.map; } setMap(map) { this.map = map; } },
    Event: {listeners: new Map(), addListener(marker, type, listener) { this.listeners.set(marker, listener); }},
  }};

  const hospitals = hospitalsResponse();
  const realtime = realtimeResponse(hospitals.items);
  if (tweak) tweak(hospitals, realtime);       // 시험별로 병원·실시간 자료를 바꿀 때
  const ok = body => ({ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body))});
  async function fetch(url, options) {
    if (url === "/api/hospitals") return ok(hospitals);
    if (url === "/api/rules") return ok(rules);
    if (url === "/api/realtime") return realtimeFails ? {ok: false, status: 503, json: async () => ({detail: "실시간 병상 정보가 아직 설정되지 않았어요."})} : ok(realtime);
    if (url === "/api/symptom/parse") {
      const sent = JSON.parse(options.body);
      symptomRequests.push(sent);
      const answer = typeof symptom === "function" ? symptom(sent) : symptom;
      return answer ? ok(answer) : {ok: false, status: 503, json: async () => ({detail: "자연어 검색이 아직 설정되지 않았어요."})};
    }
    if (url === "/api/explain") {
      const sent = JSON.parse(options.body);
      explainRequests.push(sent);
      return ok({summary: "조건을 충족한 " + sent.hospitals.length + "곳을 이동시간 순으로 보여줘요.",
                 reasons: sent.hospitals.map(hospital => ({rank: hospital.rank, text: hospital.minutes + "분 거리예요."}))});
    }
    if (url.startsWith("/api/geocode")) return ok({results: geocode || []});
    if (url.startsWith("/api/route")) {
      const params = new URLSearchParams(url.split("?")[1]);
      routeRequests.push(params);
      const index = hospitals.items.findIndex(item => item.hpid === params.get("hospital_id"));
      return ok({duration_ms: (5 + index * 3) * 60000, distance_m: (index + 1) * 2500, path: [[128.9, 37.75], [128.8, 37.7]]});
    }
    throw new Error("시험이 모르는 요청: " + url);
  }

  const context = {
    document, naver, fetch, console, URLSearchParams, AbortController, Event, CustomEvent: class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } },
    Option: function (text, value) { this.text = text; this.value = value; }, MutationObserver: class { observe() {} disconnect() {} },
    navigator: {geolocation: {getCurrentPosition(success, failure) { geoRequests.push({success, failure}); }}},
    isSecureContext: true, setTimeout, clearTimeout, setInterval: () => 0, Date, Math, JSON, Promise,
    // 전화 시험 모드용: 주소(?call_test=…), 탭 저장소, 주소 정리
    location: {search, pathname: "/", hash: ""},
    history: {replaceState(state, title, url) { urlChanges.push(url); }},
    sessionStorage: {getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)},
  };
  context.window = context;
  vm.createContext(context);
  for (const file of scripts) vm.runInContext(read(file), context, {filename: file});
  return {els, context, markers, fits, routeRequests, geoRequests, symptomRequests, explainRequests, hospitals, realtime, badges, buttonsIn, naver, urlChanges, storage,
    run: code => vm.runInContext(code, context)};
}

// 페이지처럼 지도를 띄우고, 지도가 준비되면 자동으로 요청되는 현재 위치에 응답한다.
async function start(page) {
  await page.run("showMap()");
  await new Promise(resolve => setTimeout(resolve, 5));
  if (!page.geoRequests.length) await page.els["my-location"].fire("click");
  const latest = page.geoRequests.pop();
  page.geoRequests.length = 0;
  latest.success({coords: {latitude: 37.75, longitude: 128.9}});
  await new Promise(resolve => setTimeout(resolve, 5));
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const lines = page => page.buttonsIn("search-results").map(button => button.textContent);
const tests = [];
const test = (name, body) => tests.push({name, body});

// ---------------------------------------------------------------------------
test("페이지 스크립트 순서: 공통 판정이 map.js보다 먼저", () => {
  assert.ok(scripts.indexOf("frontend/judgement.js") < scripts.indexOf("frontend/map.js"));
  assert.ok(scripts.every(file => fs.existsSync(path.join(ROOT, file))), "없는 스크립트를 불러와요");
  assert.strictEqual(new Set(ids).size, ids.length, "화면 요소 id가 겹쳐요");
});

test("조건 검색: 진료과목 일치만 결과, 확인 필요는 이동시간과 함께", async () => {
  const page = await (async () => { const p = createPage(); await start(p); return p; })();
  const {els, hospitals} = page;
  els["hospital-type"].value = "지역응급의료기관"; els.department.value = "소아청소년과"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  const results = page.buttonsIn("search-results");
  assert.ok(results.length > 0 && results.length <= 5);
  for (const button of results) {
    const hospital = hospitals.items.find(item => item.hpid === button.dataset.hpid);
    assert.ok(hospital.departments.includes("소아청소년과"));
    assert.match(button.textContent, /\(지역응급의료기관\)/);
    assert.match(button.textContent, /조건: 소아청소년과 일치\(등록\)/);
  }
  assert.match(els["search-status"].textContent, /소아청소년과 불일치 \d+곳/);
  assert.match(els["search-status"].textContent, /일반 자동차 기준 참고값/);
  const unknown = els["search-dept-unknown-list"].children.map(item => item.textContent);
  assert.ok(unknown.length > 0 && unknown.every(text => /약 \d+분 — 소아청소년과 확인 필요\(진료과목 자료 없음\)/.test(text)));
});

test("조건 검색: 중증질환 불일치는 제외, 결과에 '병원 입력' 표시, 결과 없으면 단계 설명", async () => {
  const page = createPage(); await start(page);
  const {els} = page;
  els["hospital-type"].value = "지역응급의료기관"; els.illness.value = "[재관류중재술] 심근경색"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  assert.ok(lines(page).every(text => text.includes("[재관류중재술] 심근경색 일치(가능 · 병원 입력")));
  assert.match(els["search-status"].textContent, /심근경색 불일치 \d+곳/);
  els["max-minutes"].value = "1";
  await els["hospital-search"].fire("submit");
  assert.strictEqual(lines(page).length, 0);
  assert.match(els["search-status"].textContent, /\[지역응급의료기관 \d+곳 → 조건 일치 \d+곳 → 1분 이내 0곳/);
});

test("병원 공지: 목록에 한 줄, 관련 조건 근거에 덧붙임, 끝난 공지는 숨김, 상세에 기간", async () => {
  const page = createPage(); await start(page);
  const {els} = page;
  els["hospital-type"].value = "지역응급의료기관"; els.illness.value = "[재관류중재술] 심근경색"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  const results = lines(page);
  assert.ok(results.length > 0);
  for (const text of results) {
    assert.match(text, /심근경색 일치\(가능 · 병원 입력 · ⚠ 공지: 심장내과 사정으로 CAG 불가능\)/);
    assert.match(text, /\n⚠ 병원 공지: \[\[재관류중재술\] 심근경색\] 심장내과 사정으로 CAG 불가능$/, "끝난 공지는 세지 않아야 해요");
  }
  const hospital = page.hospitals.items[0];
  page.run(`window.medinaviRealtime.renderDetail(${JSON.stringify(hospital)})`);
  const body = els["realtime-body"].children;
  assert.match(body[0].textContent, /병원 공지 \(병원이 직접 올린 내용 · 1건\)/);
  const item = body[1].children[0];
  assert.strictEqual(item.children[0].textContent, "[[재관류중재술] 심근경색] ");
  assert.match(item.textContent, /CAG 불가능 · \d+\/\d+\(.\) \d\d:\d\d까지/);
});

test("실시간: 가용/전체와 혼잡도 색, 포화·대기", async () => {
  const page = createPage(); await start(page);
  const summary = hpid => page.run(`window.medinaviRealtime.summary(${JSON.stringify(hpid)})`);
  const level = hpid => page.run(`window.medinaviRealtime.level(${JSON.stringify(hpid)})`);
  const items = page.hospitals.items;
  assert.match(summary(items[0].hpid), /^응급실 15\/20 \(원활\) · \d+분 전$/);
  assert.strictEqual(level(items[1].hpid), "보통");
  assert.strictEqual(level(items[3].hpid), "포화");
  assert.match(summary(items[4].hpid), /-5\/20 \(포화 · 대기 5\)/);
  assert.strictEqual(summary(items[2].hpid), "응급실 실시간 정보 없음");
});

test("증상 추천: 흉통 → 확인창 → 심근경색 일치 병원만 1~5순위, 근거 표시", async () => {
  const page = createPage({symptom: {category_id: "cardiac", symptom_keywords: ["가슴 통증"], is_child: false, max_minutes: 300}});
  await start(page);
  const {els} = page;
  els["symptom-query"].value = "70대 남성 가슴 통증";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.ok(els["symptom-confirm"].open);
  assert.strictEqual(els["confirm-category"].value, "cardiac");
  assert.match(page.badges[0].textContent, /^표준지침\(2023\) 기준 · 강원 지침 확인 전$/);
  // 흉통은 'ST분절 상승' 확인 항목이 있고, 체크하면 재관류 조건을 적용한다 (표준지침 p.228).
  assert.match(els["confirm-required"].textContent, /지침: 심인성 흉통 의심 → 지역응급의료센터 이상/);
  await checkFlag(page, "stemi");
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  const results = page.buttonsIn("recommend-results");
  assert.ok(results.length > 0 && results.length <= 5);
  const statusOf = hpid => page.realtime.hospitals[hpid]?.illness?.[0]?.status;
  assert.ok(results.every(button => statusOf(button.dataset.hpid) === "가능"));
  assert.match(results[0].textContent, /조건: 지역응급의료기관 이상 일치\([^)]+\) · 응급실 일반 일치\(가용 \d+\) · \[재관류중재술\] 심근경색 일치\(가능 · 병원 입력[^)]*\) · 혈관촬영기 일치/);
  // 수용 조건: 응급실 병상이 있고 혈관촬영기가 가능한 병원만 1~5순위
  const bedOf = hpid => page.realtime.hospitals[hpid].beds[0].available;
  const angioOf = hpid => page.realtime.hospitals[hpid].equipment[1].status;
  assert.ok(results.every(button => bedOf(button.dataset.hpid) > 0 && angioOf(button.dataset.hpid) === "가능"));
  assert.match(els["recommend-status"].textContent, /조건 불일치 \d+곳 제외/);
  // 심근경색은 가능하지만 지금 응급실 포화·혈관촬영기 불가인 병원은 '지금 수용 어려움'으로 따로
  const busy = page.buttonsIn("recommend-capacity-list");
  assert.ok(busy.length > 0 && !els["recommend-capacity"].hidden);
  assert.ok(busy.every(button => statusOf(button.dataset.hpid) === "가능"), "진료 역량이 없는 병원은 넣지 않아요");
  assert.ok(busy.some(button => /응급실 일반 불일치\(가용 0 · 포화\)/.test(button.textContent)), busy.map(b => b.textContent).join("\n"));
  assert.match(els["recommend-capacity-summary"].textContent, /지금 수용 어려움 \(\d+곳/);
  assert.match(els["recommend-status"].textContent, /지금 수용 어려움 \d+곳/);
  assert.match(els["confirm-required"].textContent, /^Pre-KTAS 미입력 → 중증 기준 \| 공통 수용 조건: 응급실 일반 가용 \| 지침: ST분절 상승 심근경색 → 재관류 치료가 가능한 기관 \(표준지침 p\.228, 경증은 p\.55\) · 모두 가능해야 일치: \[재관류중재술\] 심근경색, 혈관촬영기/);
  assert.match(els["recommend-notice"].textContent, /^적용 기준: ST분절 상승 심근경색 → 재관류 치료가 가능한 기관 \(표준지침 p\.228, 경증은 p\.55\)\./);
  // 1순위를 누르면 상세가 열리고 목록에서도 강조된다.
  await results[0].fire("click");
  assert.strictEqual(els["hospital-detail"].hidden, false);
  assert.strictEqual(results[0].attrs["aria-current"], "true");
});

test("증상 추천: AI 실패 시 직접 분류, 확인 필요가 많으면 접기, 조건 검색과 서로 정리", async () => {
  const page = createPage(); await start(page);
  const {els} = page;
  els["symptom-query"].value = "손가락 절단";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.ok(els["symptom-confirm"].open);
  assert.strictEqual(els["confirm-category"].value, "unclear");
  assert.match(els["symptom-note"].textContent, /직접 골라 주세요/);
  els["confirm-category"].value = "amputation";
  els["rec-minutes"].value = "300";
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.strictEqual(els["recommend-results"].children.length, 0);
  assert.ok(els["recommend-unknown-list"].children.length > 5 && els["recommend-unknown"].open === false);
  assert.match(els["recommend-status"].textContent, /\[후보 \d+곳 → 조건 일치 0곳/);
  // 조건 검색을 하면 추천 결과가 정리된다.
  els["hospital-type"].value = "지역응급의료기관"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  assert.strictEqual(els["recommend-area"].hidden, true);
});

test("조건 바꾸기: 직전 조건을 함께 보내고, 바뀐 항목을 알려주고, 다시 찾기", async () => {
  const adult = {category_id: "cardiac", symptom_keywords: ["가슴 통증"], is_child: false, max_minutes: 300};
  const page = createPage({symptom: sent => sent.previous ? {...adult, symptom_keywords: [], is_child: true}
    : sent.query === "다른 증상" ? {...adult, max_minutes: null} : adult});
  await start(page);
  const {els} = page;
  assert.ok(els["refine-form"].hidden, "검색 전에는 조건 바꾸기를 숨겨요");
  els["symptom-query"].value = "가슴 통증";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  els["rec-type"].value = "지역응급의료기관";
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.ok(!els["refine-form"].hidden);
  assert.strictEqual(els["refine-current"].textContent, "현재 조건: 흉통 · 심인성 의심 · Pre-KTAS 미입력(중증) · 나이 미상 · 300분 이내 · 지역응급의료기관");

  els["refine-query"].value = "7살 아이예요";
  await els["refine-form"].listeners.submit[0]({preventDefault() {}});
  const sent = page.symptomRequests.at(-1);
  assert.deepStrictEqual(sent, {query: "7살 아이예요", previous: {query: "가슴 통증", category_id: "cardiac", secondary_category_id: null, is_child: false, max_minutes: 300, age_months: null}});
  assert.ok(els["symptom-confirm"].open, "바뀐 조건은 확인창에서 다시 확인해요");
  assert.strictEqual(els["symptom-note"].textContent, "바뀐 항목: 소아 아니오 → 예");
  assert.strictEqual(els["rec-type"].value, "지역응급의료기관", "언급 안 한 유형은 그대로");
  assert.strictEqual(els["refine-query"].value, "");
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.match(els["refine-current"].textContent, /· 나이 미상\(소아\) ·/);

  // 다음 조건 바꾸기 때는 문장이 이어 붙어 전체 맥락이 간다.
  els["refine-query"].value = "30분 안으로";
  await els["refine-form"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(page.symptomRequests.at(-1).previous.query, "가슴 통증 / 7살 아이예요");
  els["symptom-confirm"].close();

  // 새 증상 검색은 직전 이동시간(300분)을 이어받지 않는다.
  els["rec-minutes"].value = "20";
  els["symptom-query"].value = "다른 증상";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(String(els["rec-minutes"].value), "60", "문장에 시간이 없으면 기본 60분");
});

test("AI 결과 설명: 화면의 판정·근거만 보내고, 버튼을 눌렀을 때 순위별로 보여줌", async () => {
  const page = createPage({symptom: {category_id: "cardiac", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: 300}});
  await start(page);
  const {els} = page;
  assert.ok(els["explain-area"].hidden);
  els["symptom-query"].value = "가슴 통증";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  await checkFlag(page, "stemi");
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.ok(!els["explain-area"].hidden && els["explain-box"].hidden);
  assert.strictEqual(page.explainRequests.length, 0, "누르기 전에는 AI를 부르지 않아요");
  await els["explain-button"].fire("click");
  await tick();
  const sent = page.explainRequests[0];
  const results = page.buttonsIn("recommend-results");
  assert.strictEqual(sent.condition, "흉통 · 심인성 의심 · Pre-KTAS 미입력(중증) · 지역응급의료기관 이상 · 나이 미상 · 300분 이내 · 전체 유형");
  assert.deepStrictEqual(sent.hospitals.map(h => h.rank), results.map((_, index) => index + 1));
  assert.ok(sent.hospitals[0].conditions.some(text => /심근경색 일치/.test(text)), sent.hospitals[0].conditions.join(" / "));
  assert.match(sent.hospitals[0].notice, /⚠ 병원 공지: \[\[재관류중재술\] 심근경색\] 심장내과 사정으로 CAG 불가능/);
  assert.match(sent.hospitals[0].realtime, /응급실/);
  assert.strictEqual(sent.funnel, "");
  assert.ok(!els["explain-box"].hidden);
  assert.match(els["explain-summary"].textContent, /조건을 충족한 \d+곳/);
  const first = els["explain-reasons"].children[0];
  assert.strictEqual(first.children[0].textContent, "1순위 " + sent.hospitals[0].name + ": ");
  assert.ok(els["explain-button"].disabled, "같은 결과는 한 번만 설명해요");
  // 새로 검색하면 설명을 지운다.
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.ok(els["explain-box"].hidden && !els["explain-button"].disabled);
  assert.strictEqual(els["explain-reasons"].children.length, 0);
});

test("두 분류: 모두 일치가 없으면 일부 일치 묶음과 한 분류만 다시 찾기 버튼", async () => {
  // 심근경색 '가능' 병원은 분만 '불가'로 바꿔, 두 분류를 모두 만족하는 곳이 없게 한다.
  const tweak = (hospitals, realtime) => hospitals.items.forEach((item, index) => {
    const illness = realtime.hospitals[item.hpid]?.illness;
    if (illness?.length && illness[0].status === "가능") illness[15].status = "불가";
  });
  const page = createPage({tweak, symptom: {category_id: "obstetric", secondary_category_id: "cardiac", symptom_keywords: [], is_child: false, max_minutes: 300}});
  await start(page);
  const {els} = page;
  els["symptom-query"].value = "만삭 산모가 진통 중인데 가슴이 아파요";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(els["confirm-category2"].value, "cardiac");
  // 두 분류의 확인 항목이 함께 나온다.
  assert.deepStrictEqual(flagLabels(page), ["고위험 태아·미숙아 분만", "분만이 임박한 만삭 임신부", "12유도 심전도에서 ST분절 상승 확인"]);
  await checkFlag(page, "labor");
  await checkFlag(page, "stemi");
  assert.match(els["confirm-required"].textContent, /분만.*\|.*심근경색.*두 분류 조건을 모두 확인하고, 기관 등급은 더 높은 쪽을 적용/);
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.strictEqual(page.buttonsIn("recommend-results").length, 0);
  assert.match(els["recommend-status"].textContent, /임신 · 분만 \+ 흉통 · 심인성 의심 · Pre-KTAS 미입력\(중증\) · 예상 300분 이내 모두 일치 0곳 · 일부 일치 \d+곳/);
  assert.match(els["recommend-status"].textContent, /모두 일치 0곳 → 300분 이내 0곳/);
  const partial = page.buttonsIn("recommend-partial-list");
  assert.ok(partial.length > 0 && !els["recommend-partial"].hidden && els["recommend-partial"].open);
  assert.ok(partial.some(b => /흉통 · 심인성 의심 조건 빠짐: \[재관류중재술\] 심근경색 불일치/.test(b.textContent)), partial.map(b => b.textContent).join("\n"));
  assert.ok(partial.some(b => /임신 · 분만 조건 빠짐: \[산부인과응급\] 분만 불일치/.test(b.textContent)), partial.map(b => b.textContent).join("\n"));
  const retry = els["recommend-fallback"].children;
  assert.ok(!els["recommend-fallback"].hidden && retry.length === 2);
  assert.strictEqual(retry[1].textContent, "흉통 · 심인성 의심만 적용해서 다시 찾기");
  await retry[1].fire("click");
  await tick();
  // 다시 찾을 때도 체크한 항목(ST분절 상승)을 그대로 쓴다.
  const results = page.buttonsIn("recommend-results");
  assert.ok(results.length > 0 && results.every(b => page.realtime.hospitals[b.dataset.hpid].illness[0].status === "가능"));
  assert.ok(els["recommend-partial"].hidden && els["recommend-fallback"].hidden);
  assert.match(els["refine-current"].textContent, /현재 조건: 흉통 · 심인성 의심 · Pre-KTAS 미입력\(중증\) · 나이 미상/);
});

test("병원 상세: 추가 확인 사항에 전화 확인, 검색 조건 확인 필요, 공지, 이동시간 한계", async () => {
  const page = createPage(); await start(page);
  const {els} = page;
  els["hospital-type"].value = "지역응급의료기관"; els.illness.value = "[재관류중재술] 심근경색"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  const items = page.hospitals.items;
  // 심근경색 '확인 필요'인 지역응급의료기관 하나를 고른다 (index % 3 === 2, 실시간 있음)
  const unsure = items.find((item, index) => index % 3 === 2 && index % 6 !== 5 && index !== 2 && item.dutyEmclsName === "지역응급의료기관");
  page.run(`showHospitalDetail(${JSON.stringify(unsure)}, window.medinaviData)`);
  const texts = els["detail-checks-list"].children.map(item => item.textContent);
  assert.match(texts[0], /출발 전에 응급실\(.+\)에 전화로 확인/);
  assert.ok(texts.some(text => /검색 조건 '\[재관류중재술\] 심근경색': .*확인 필요/.test(text)), texts.join("\n"));
  assert.ok(texts.some(text => /병원이 입력한 값이고 갱신 시각이 제공되지 않아요/.test(text)));
  assert.match(texts.at(-1), /일반 자동차 기준 참고값/);

  const withNotice = items[0];
  page.run(`showHospitalDetail(${JSON.stringify(withNotice)}, window.medinaviData)`);
  assert.ok(els["detail-checks-list"].children.some(item => /공지가 1건/.test(item.textContent)));
});

test("출발지 주소: 고른 주소로 길찾기, 버튼 이름 변경, 늦게 온 위치 응답 무시", async () => {
  const page = createPage({geocode: [{road_address: "강원특별자치도 원주시 시청로 1", jibun_address: "무실동 1", latitude: 37.3422, longitude: 127.9202}]});
  await start(page);
  const {els} = page;
  assert.strictEqual(els["search-button"].textContent, "내 위치 기준으로 검색");
  await els["my-location"].fire("click");
  const pending = page.geoRequests.shift();
  els["origin-query"].value = "원주시 시청로 1";
  await els["origin-search"].listeners.submit[0]({preventDefault() {}});
  await els["origin-results"].children[0].children[0].onclick();
  pending.success({coords: {latitude: 1, longitude: 1}});               // 늦게 온 위치 응답
  assert.strictEqual(els["search-button"].textContent, "출발지(강원특별자치도 원주시 시청로 1) 기준으로 검색");
  els["hospital-type"].value = "지역응급의료기관"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  const last = page.routeRequests[page.routeRequests.length - 1];
  assert.strictEqual(last.get("start_lat"), "37.3422");
});

test("실시간 정보를 못 불러와도 조건 검색은 동작하고 중증질환은 확인 필요로", async () => {
  const page = createPage({realtimeFails: true}); await start(page);
  const {els} = page;
  els["hospital-type"].value = "지역응급의료기관"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  assert.ok(lines(page).length > 0);
  els.illness.value = "[재관류중재술] 심근경색";
  await els["hospital-search"].fire("submit");
  assert.strictEqual(lines(page).length, 0);
  assert.ok(els["search-ill-unknown-list"].children.every(item => item.textContent.includes("실시간 정보를 불러오지 못함")));
});


// 목록 한 줄(li)에 붙은 전화 버튼
const callsIn = (page, id) => page.els[id].children.map(item => item.children.find(child => child.className === "call-link"));

test("전화 버튼: 결과·확인 필요·상세에 응급실 번호로 바로 전화", async () => {
  const page = createPage(); await start(page);
  const {els, hospitals} = page;
  assert.ok(els["call-test-banner"].hidden, "시험 모드가 아니면 알림을 숨겨요");
  els["hospital-type"].value = "지역응급의료기관"; els.illness.value = "[재관류중재술] 심근경색"; els["max-minutes"].value = "300";
  await els["hospital-search"].fire("submit");
  const results = page.buttonsIn("search-results");
  const calls = callsIn(page, "search-results");
  assert.ok(results.length > 0 && calls.length === results.length);
  calls.forEach((call, index) => {
    const hospital = hospitals.items.find(item => item.hpid === results[index].dataset.hpid);
    assert.ok(call, hospital.dutyName + "에 전화 버튼이 없어요");
    const number = page.run("window.medinaviCall.dialable(" + JSON.stringify(hospital.dutyTel3) + ")");
    assert.strictEqual(call.href, "tel:" + number);
    assert.ok(call.textContent.startsWith("📞 전화 응급실 "), call.textContent);
    assert.match(call.attrs["aria-label"], new RegExp(hospital.dutyName + " 응급실에 전화 걸기"));
  });
  assert.ok(callsIn(page, "search-ill-unknown-list").every(Boolean), "확인 필요 기관에도 전화 버튼");
  // 상세: 응급실 연락처 칸에 전화 버튼, 번호 글자는 그대로
  const hospital = hospitals.items[0];
  page.run(`showHospitalDetail(${JSON.stringify(hospital)}, window.medinaviData)`);
  const fields = els["detail-fields"].children;
  const phoneField = fields[fields.findIndex(field => field.textContent === "응급실 연락처") + 1];
  assert.match(phoneField.textContent, new RegExp("^" + hospital.dutyTel3));
  assert.strictEqual(phoneField.children[0].href, "tel:" + hospital.dutyTel3.replace(/[^0-9]/g, ""));
  // 응급실 번호가 없으면 대표번호, 둘 다 없으면 버튼 없음
  assert.strictEqual(page.run(`window.medinaviCall.link({dutyName: "가", dutyTel1: "033-111-2222"}).textContent`), "📞 전화 대표번호 033-111-2222");
  assert.strictEqual(page.run(`window.medinaviCall.link({dutyName: "가"})`), null);
});

test("전화 시험 모드: ?call_test=내 번호면 모든 전화 버튼이 그 번호로, 주소에서 번호 지우기, 끄기", async () => {
  const storage = new Map();
  const page = createPage({search: "?call_test=010-1234-5678&r=3", storage,
    symptom: {category_id: "cardiac", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: 300}});
  await start(page);
  const {els, hospitals} = page;
  assert.ok(!els["call-test-banner"].hidden);
  assert.match(els["call-test-banner"].textContent, /병원 대신 010-1234-5678\(으\)로 걸려요/);
  assert.deepStrictEqual(page.urlChanges, ["/?r=3"], "번호는 주소창에서 지워요");
  assert.strictEqual(storage.get("medinavi-call-test"), "01012345678");
  // 증상 추천 결과·지금 수용 어려움도 모두 내 번호로
  els["symptom-query"].value = "가슴 통증";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  await checkFlag(page, "stemi");
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  const calls = [...callsIn(page, "recommend-results"), ...callsIn(page, "recommend-capacity-list")];
  assert.ok(calls.length > 1 && calls.every(call => call.href === "tel:01012345678" && call.dataset.test === "true"));
  assert.strictEqual(calls[0].textContent, "📞 전화 (시험: 010-1234-5678)");
  // 끄기: 알림이 사라지고 이미 그려진 버튼도 병원 번호로 돌아간다.
  await els["call-test-banner"].children[0].fire("click");
  assert.ok(els["call-test-banner"].hidden);
  assert.ok(!storage.has("medinavi-call-test"));
  const first = hospitals.items.find(item => item.hpid === page.buttonsIn("recommend-results")[0].dataset.hpid);
  assert.strictEqual(calls[0].href, "tel:" + first.dutyTel3.replace(/[^0-9]/g, ""));

  // 같은 탭에서 새로고침하면(주소에 번호 없음) 저장된 시험 모드가 이어진다.
  storage.set("medinavi-call-test", "01099998888");
  const again = createPage({storage}); await start(again);
  assert.match(again.els["call-test-banner"].textContent, /010-9999-8888/);
  assert.strictEqual(again.run(`window.medinaviCall.link(${JSON.stringify(hospitals.items[0])}).href`), "tel:01099998888");

  // 휴대폰 번호가 아니면(유료 060 등) 켜지 않고 알려준다.
  const bad = createPage({search: "?call_test=0601234567", storage: new Map()}); await start(bad);
  assert.match(bad.els["call-test-banner"].textContent, /켜지 못했어요/);
  assert.strictEqual(bad.run(`window.medinaviCall.testNumber()`), "");
  assert.strictEqual(bad.run(`window.medinaviCall.link(${JSON.stringify(hospitals.items[0])}).href`), "tel:" + hospitals.items[0].dutyTel3.replace(/[^0-9]/g, ""));
  // ?call_test=off 로 끈다.
  const offStorage = new Map([["medinavi-call-test", "01012345678"]]);
  const off = createPage({search: "?call_test=off", storage: offStorage}); await start(off);
  assert.ok(off.els["call-test-banner"].hidden && !offStorage.has("medinavi-call-test"));
});


// 확인창의 분류별 체크 항목 (label > input[data-flag])
const flagInputs = page => page.els["confirm-flags"].children.map(label => label.children[0]);
const flagLabels = page => page.els["confirm-flags"].children.map(label => label.textContent.trim());
async function checkFlag(page, id, on = true) {
  const box = flagInputs(page).find(input => input.dataset.flag === id);
  assert.ok(box, "확인 항목이 없어요: " + id);
  box.checked = on;
  await box.fire("change");
}
const typeOf = (page, button) => page.hospitals.items.find(item => item.hpid === button.dataset.hpid).dutyEmclsName;
async function searchSymptom(page, {ktas = "", flags = [], minutes = "300", child = false, age = null} = {}) {
  const {els} = page;
  els["symptom-query"].value = "증상";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  els["confirm-ktas"].value = ktas;
  els["confirm-child"].checked = child;
  if (age) await setAge(page, ...age);
  await els["confirm-ktas"].fire("change");
  for (const flag of flags) await checkFlag(page, flag);
  els["rec-minutes"].value = minutes;
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
}
const CENTERS = ["권역응급의료센터", "지역응급의료센터"];

test("표준지침: Pre-KTAS 1·2(또는 미입력)는 중증 → 지역응급의료센터 이상, 등급만 낮은 곳은 '의료지도 필요'", async () => {
  const page = createPage({symptom: {category_id: "respiratory", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: null}});
  await start(page);
  const {els} = page;
  await searchSymptom(page);
  assert.match(els["confirm-required"].textContent, /^Pre-KTAS 미입력 → 중증 기준 \| .*지침: 중증 호흡곤란 → 지역응급의료센터 이상 \(표준지침 p\.221, 소아 p\.310\).*중증 기준\(참고\): 의식 변화/);
  const results = page.buttonsIn("recommend-results");
  assert.ok(results.length > 0 && results.every(b => CENTERS.includes(typeOf(page, b))), results.map(b => typeOf(page, b)).join(","));
  assert.match(results[0].textContent, /조건: 지역응급의료센터 이상 일치\((권역|지역)응급의료센터\)/);
  // 등급은 낮지만 조건에 맞는 가까운 기관: 따로 묶고, 등급과 '의료지도 필요'를 적는다.
  const guided = page.buttonsIn("recommend-guided-list");
  assert.ok(guided.length > 0 && !els["recommend-guided"].hidden);
  assert.ok(guided.every(b => !CENTERS.includes(typeOf(page, b))));
  assert.match(guided[0].textContent, / — (지역응급의료기관|응급실운영신고기관) \(지침: 지역응급의료센터 이상\) · 조건 일치$/);
  // 의료지도 필요에는 조건이 모두 일치하는 기관만 (확인 필요는 넣지 않음: 지침은 '치료 가능한' 가까운 기관)
  assert.ok(guided.every(b => page.run(`window.medinaviJudge.checksFor(${JSON.stringify(b.dataset.hpid)})`).filter(check => check.kind !== "reference" && check.kind !== "level").every(check => check.status === "가능")));
  assert.match(els["recommend-guided-summary"].textContent, /의료지도 필요 \(\d+곳 · 지침 등급보다 낮지만 가까운 곳\)/);
  assert.match(els["recommend-status"].textContent, /의료지도 필요 \d+곳/);
  // '상위 5곳 표시'는 순위에 드는 기관이 5곳을 넘을 때만 (의료지도 필요 기관은 세지 않음)
  if (results.length < 5) assert.doesNotMatch(els["recommend-status"].textContent, /상위 5곳 표시/);
  assert.ok(callsIn(page, "recommend-guided-list").every(Boolean), "의료지도 필요 기관에도 전화 버튼");
  assert.match(els["recommend-notice"].textContent, /적용 기준: 중증 호흡곤란 → 지역응급의료센터 이상/);
  // 상세 '추가 확인 사항'에 등급 설명
  await guided[0].fire("click");
  assert.ok(els["detail-checks-list"].children.some(item => /표준지침 기본 등급\(지역응급의료센터 이상\)보다 낮은 기관이에요\(.+\)\. 지역 여건에 따라 의료지도를 받으면/.test(item.textContent)),
    els["detail-checks-list"].children.map(item => item.textContent).join("\n"));

  // Pre-KTAS 4(준응급)는 경증 → 가장 가까운 지역응급의료기관 (센터가 아니어도 순위에 든다)
  await searchSymptom(page, {ktas: "4"});
  assert.match(els["confirm-required"].textContent, /^Pre-KTAS 4\(준응급\) → 경증 기준 \| .*지침: 경증 호흡곤란 → 가장 가까운 지역응급의료기관/);
  const mild = page.buttonsIn("recommend-results");
  assert.ok(mild.some(b => typeOf(page, b) === "지역응급의료기관"), mild.map(b => typeOf(page, b)).join(","));
  assert.ok(page.buttonsIn("recommend-guided-list").every(b => typeOf(page, b) === "응급실운영신고기관"));
  assert.match(els["refine-current"].textContent, /Pre-KTAS 4\(경증\)/);
  // AI 설명에도 적용한 등급이 들어간다.
  await els["explain-button"].fire("click");
  assert.match(page.explainRequests.at(-1).condition, /호흡곤란 · Pre-KTAS 4\(경증\) · 지역응급의료기관 이상/);
});

test("표준지침: 분류별 확인 항목(경련 중)과 소아 안내, 고정 중증 분류(심정지)", async () => {
  const page = createPage({symptom: sent => sent.query === "심정지" ? {category_id: "cardiac_arrest", secondary_category_id: null, symptom_keywords: [], is_child: null, max_minutes: null}
    : {category_id: "seizure", secondary_category_id: null, symptom_keywords: [], is_child: true, max_minutes: null}});
  await start(page);
  const {els} = page;
  // 경련이 멈춤(기본) → 지역응급의료센터 이상
  await searchSymptom(page, {child: true});
  assert.deepStrictEqual(flagLabels(page), ["지금도 경련 중", "임산부"]);
  assert.ok(page.buttonsIn("recommend-results").every(b => CENTERS.includes(typeOf(page, b))));
  // 지금도 경련 중 → 가장 가까운 지역응급의료기관 이상 (거리 우선)
  await searchSymptom(page, {flags: ["seizing"], child: true});
  assert.match(els["confirm-required"].textContent, /지침: 경련 중 → 가장 가까운 지역응급의료기관 이상 \(표준지침 p\.257, 소아 p\.314\)/);
  assert.match(els["recommend-notice"].textContent, /항경련제 정맥 투여가 가장 급해서/);
  assert.ok(page.buttonsIn("recommend-results").some(b => typeOf(page, b) === "지역응급의료기관"));
  // 새 검색이면 체크 항목을 비운다.
  els["symptom-query"].value = "심정지";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(els["confirm-category"].value, "cardiac_arrest");
  assert.deepStrictEqual(flagLabels(page), []);
  assert.ok(els["confirm-flags"].hidden);
  // 심정지는 Pre-KTAS와 상관없이 같은 기준이고, 중증도 문구를 붙이지 않는다.
  els["confirm-ktas"].value = "5";
  await els["confirm-ktas"].fire("change");
  assert.match(els["confirm-required"].textContent, /^공통 수용 조건: 응급실 일반 가용 \| 지침: 심정지 → 가장 가까운 지역응급의료기관 이상/);
});

test("표준지침: 데이터가 없는 조건이 핵심인 분류(뇌졸중·정신과·뱀)는 일반 기준과 제외 사유", async () => {
  const page = createPage({symptom: {category_id: "stroke", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: null}});
  await start(page);
  const {els} = page;
  await searchSymptom(page);
  assert.match(els["confirm-required"].textContent, /⚠ 뇌졸중은 '즉각적인 혈전용해치료가 가능한 기관' 정보가 API에 없어/);
  assert.match(els["recommend-notice"].textContent, /119구급상황관리센터에 병원 정보를 요청하세요/);
  // 뇌경색 재관류 조건은 쓰지 않는다 (뇌경색 '불가' 병원도 순위에 들 수 있음).
  assert.ok(page.buttonsIn("recommend-results").every(b => !/뇌경색/.test(b.textContent)));
  const ids = page.run("Array.from(document.querySelector('#confirm-category').options, option => option.value)");
  for (const id of ["stroke", "psychiatric", "snakebite"]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes("pediatric"), "소아 일반 분류는 없앴어요");
});

test("표준지침: 중증외상은 권역외상센터, 정보가 없으면 확인 필요, 멀면 헬기 안내", async () => {
  const trauma = {symptom: {category_id: "trauma", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: null}};
  // 1) 외상센터 지정 정보가 hospitals.json에 없을 때(refresh_hospitals.py --write 전): 등급을 '확인 필요'로 두고 알린다.
  const page = createPage({...trauma, tweak: hospitals => hospitals.items.forEach(item => { delete item.trauma_center; })}); await start(page);
  await searchSymptom(page);
  assert.strictEqual(page.buttonsIn("recommend-results").length, 0);
  assert.ok(page.els["recommend-unknown-list"].children.some(item => /권역외상센터 확인 필요\(외상센터 지정 정보 미반영\)/.test(item.textContent)));
  assert.match(page.els["recommend-notice"].textContent, /^⚠ 외상센터 지정 정보가 아직 반영되지 않아/);
  // 2) 외상센터가 멀면(30km 넘음) 헬기 이송·의료지도 안내 (가짜 길찾기: 순서 i번 병원은 (i+1)×2.5km)
  const far = createPage({...trauma, tweak: hospitals => hospitals.items.forEach((item, index) => { item.trauma_center = index === 14; })});
  await start(far);
  await searchSymptom(far);
  const ranked = far.buttonsIn("recommend-results");
  assert.ok(ranked.every(b => far.hospitals.items.find(item => item.hpid === b.dataset.hpid).trauma_center));
  assert.match(far.els["recommend-notice"].textContent, /^🚁 권역외상센터까지 약 \d+분 · 37\.5km\. 표준지침 p\.54, p\.325/);
  // 외상센터가 아닌 가까운 기관은 '의료지도 필요'로
  assert.ok(far.buttonsIn("recommend-guided-list").length > 0);
  // 순위는 1곳뿐이므로 '상위 5곳 표시'를 붙이지 않는다 (의료지도 필요 기관은 세지 않음)
  assert.strictEqual(ranked.length, 1);
  assert.match(far.els["recommend-status"].textContent, /조건 일치 1곳 · 의료지도 필요 \d+곳/);
  // 3) 가까우면 헬기 안내를 띄우지 않는다. 경증(Pre-KTAS 3~5)은 가장 가까운 지역응급의료기관.
  const near = createPage({...trauma, tweak: hospitals => hospitals.items.forEach((item, index) => { item.trauma_center = index === 1; })});
  await start(near);
  await searchSymptom(near);
  assert.doesNotMatch(near.els["recommend-notice"].textContent, /🚁/);
  await searchSymptom(near, {ktas: "3"});
  assert.match(near.els["confirm-required"].textContent, /지침: 경증 외상 → 가장 가까운 지역응급의료기관/);
  assert.ok(near.buttonsIn("recommend-results").length > 0);
});


async function setAge(page, value, unit = "세") {
  page.els["confirm-age"].value = String(value);
  page.els["confirm-age-unit"].value = unit;
  await page.els["confirm-age"].fire("input");
}

test("인접 시·도: 경기 등 타 시·도 병원도 후보로 넣고 표시, 직선거리로 닿을 수 없는 병원은 길찾기 안 함", async () => {
  const tweak = (hospitals, realtime) => {
    const center = hospitals.items.find(item => item.dutyEmclsName === "지역응급의료센터");
    const live = JSON.parse(JSON.stringify(realtime.hospitals[hospitals.items[0].hpid]));   // 병상 여유가 있는 실시간 정보
    realtime.hospitals.G_NEAR = live;
    realtime.hospitals.G_FAR = live;
    // 가까운 경기 병원(가짜 길찾기에서 순서가 0번이라 가장 가까움)과, 직선거리 250km 넘는 먼 병원
    hospitals.items.unshift({...JSON.parse(JSON.stringify(center)), hpid: "G_NEAR", dutyName: "경기가까운병원", sido: "경기도", wgs84Lat: "37.7", wgs84Lon: "128.8"});
    hospitals.items.push({...JSON.parse(JSON.stringify(center)), hpid: "G_FAR", dutyName: "경북먼병원", sido: "경상북도", wgs84Lat: "35.6", wgs84Lon: "128.0"});
  };
  const page = createPage({tweak, symptom: {category_id: "respiratory", secondary_category_id: null, symptom_keywords: [], is_child: false, max_minutes: null}});
  await start(page);
  await searchSymptom(page, {minutes: "120"});
  const results = page.buttonsIn("recommend-results");
  assert.strictEqual(results[0].dataset.hpid, "G_NEAR");
  assert.match(results[0].textContent, /^1\. 경기가까운병원 \(지역응급의료센터 · 타 시·도\(경기도\)\)/);
  const asked = page.routeRequests.map(params => params.get("hospital_id"));
  assert.ok(asked.includes("G_NEAR") && !asked.includes("G_FAR"), "120분이면 직선 240km 넘는 병원은 길찾기를 하지 않아요");
  assert.ok(asked.length < page.hospitals.items.length);
  // 강원 병원(시·도 정보 없음 또는 강원)에는 표시를 붙이지 않는다.
  assert.ok(results.slice(1).every(button => !/타 시·도/.test(button.textContent)));
  // 상세에 시·도 줄
  await results[0].fire("click");
  assert.ok(page.els["detail-fields"].children.some(item => /경기도 \(타 시·도/.test(item.textContent)));
  // 시간 제한을 넉넉히 하면 먼 병원도 길찾기를 한다.
  await searchSymptom(page, {minutes: "300"});
  assert.ok(page.routeRequests.some(params => params.get("hospital_id") === "G_FAR"));
});

test("전화번호 정리: 범위 표기·대표번호 앞 지역번호·지역번호 없는 대표번호 (인접 시·도 병원 실제 표기)", async () => {
  const page = createPage();
  await start(page);
  const dial = value => page.run("window.medinaviCall.dialable(" + JSON.stringify(value) + ")");
  assert.strictEqual(dial("031-574-9118~9"), "0315749118");
  assert.strictEqual(dial("031-1644-9118"), "16449118");
  assert.strictEqual(dial("1661-7500"), "16617500");
  assert.strictEqual(dial("0318285000"), "0318285000");
  assert.strictEqual(dial("031-828-5000"), "0318285000");
  assert.strictEqual(dial("033-610-3114"), "0336103114");
  assert.strictEqual(dial("02-123-4567"), "021234567");
  assert.strictEqual(dial("119"), "");
  assert.strictEqual(dial(""), "");
  const link = page.run("window.medinaviCall.link({dutyName: '구리', dutyTel3: '031-1644-9118'})");
  assert.strictEqual(link.dataset.phone, "16449118");
  assert.strictEqual(link.dataset.display, "응급실 1644-9118");
});

test("나이: AI가 읽은 나이를 채우고, 나이로 소아 여부와 나이별 기준(생후 3개월 미만 발열)을 정함", async () => {
  const page = createPage({symptom: sent => sent.previous ? {category_id: "fever", secondary_category_id: null, symptom_keywords: [], is_child: null, max_minutes: null, age_months: null}
    : {category_id: "fever", secondary_category_id: null, symptom_keywords: [], is_child: true, max_minutes: null, age_months: 2}});
  await start(page);
  const {els, hospitals} = page;
  els["symptom-query"].value = "생후 2개월 아기가 열이 38도예요";
  await els["symptom-search"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(els["confirm-age"].value, "2");
  assert.strictEqual(els["confirm-age-unit"].value, "개월");
  assert.ok(els["confirm-child"].checked && els["confirm-child"].disabled, "나이가 있으면 소아 여부는 자동");
  assert.deepStrictEqual(flagLabels(page), ["소아: 미숙아로 태어나는 등 과거력 있음"]);
  assert.match(els["confirm-required"].textContent, /지침: 생후 3개월 미만 발열 → 소아 진료가 가능한 지역응급의료기관 이상 \(표준지침 p\.264, 소아 p\.316\) · 모두 가능해야 일치: 소아청소년과/);
  els["rec-minutes"].value = "300";
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  const results = page.buttonsIn("recommend-results");
  assert.ok(results.length > 0 && results.every(b => hospitals.items.find(item => item.hpid === b.dataset.hpid).departments.includes("소아청소년과")));
  assert.match(els["refine-current"].textContent, /· 생후 2개월 ·/);
  assert.match(els["recommend-notice"].textContent, /평소 다니는 병원.*선택 사항이에요/);
  // 조건 바꾸기: 나이를 함께 보내고, 언급이 없으면 나이를 그대로 둔다.
  els["refine-query"].value = "30분 안으로";
  await els["refine-form"].listeners.submit[0]({preventDefault() {}});
  assert.strictEqual(page.symptomRequests.at(-1).previous.age_months, 2);
  assert.strictEqual(els["confirm-age"].value, "2");
  // 5세로 바꾸면 3개월 기준은 빠지고 일반 발열 기준, 소아 표시는 그대로
  await setAge(page, 5);
  assert.ok(els["confirm-child"].checked);
  assert.match(els["confirm-required"].textContent, /지침: 중증 → 지역응급의료센터 이상/);
  // 과거력(미숙아 등) 체크 → 소아 진료 가능 기관
  await checkFlag(page, "preterm_history");
  assert.match(els["confirm-required"].textContent, /지침: 과거력\(미숙아 등\) 있는 소아 발열 → 소아 진료가 가능한/);
  // 40세 성인: 소아 아님, 과거력 체크가 있어도 소아 기준은 쓰지 않는다.
  await setAge(page, 40);
  assert.ok(!els["confirm-child"].checked && els["confirm-child"].disabled);
  assert.match(els["confirm-required"].textContent, /지침: 중증 → 지역응급의료센터 이상/);
  // 나이를 지우면 체크박스로 고를 수 있다.
  els["confirm-age"].value = "";
  await els["confirm-age"].fire("input");
  assert.ok(!els["confirm-child"].disabled);
  for (const listener of els["symptom-go"].listeners.click) await listener();
  await tick();
  assert.match(els["refine-current"].textContent, /· 나이 미상 ·/);
});


test("기본 화면(index.html): 공통 스크립트가 쓰는 요소와 스크립트 버전이 백업 화면과 같음", () => {
  const mainIds = new Set([...mainHtml.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  // 새 화면은 Pre-KTAS를 확인창 선택 칸 대신 홈 화면 버튼(window.medinaviPreKtas)으로 받는다.
  const missing = ids.filter(id => !mainIds.has(id) && !["confirm-ktas", "confirm-ktas-note", "search-title"].includes(id));
  assert.deepStrictEqual(missing, [], "기본 화면에 없는 요소: " + missing.join(", "));
  assert.strictEqual(mainIds.size, [...mainHtml.matchAll(/\sid="([^"]+)"/g)].length, "기본 화면 요소 id가 겹쳐요");
  // 표준지침 기준 표시 자리
  for (const id of ["sum-age", "sum-guide", "sum-guide-main", "flag-wrap", "sum-guide-warn", "guide-banner", "guide-banner-warn", "recommend-guided-list"]) assert.ok(mainIds.has(id), id);
  // 같은 공통 스크립트를 같은 순서·같은 버전으로 불러와야 캐시된 예전 파일이 섞이지 않는다.
  const tags = page => [...page.matchAll(/<script src="\/static\/([^"]+)"/g)].map(match => match[1]);
  const shared = tags(html);
  const mainShared = tags(mainHtml).filter(src => shared.some(other => other.split("?")[0] === src.split("?")[0]));
  assert.deepStrictEqual(mainShared, shared);
  assert.ok(tags(mainHtml).some(src => src.startsWith("ui_joonghee.js")) && tags(mainHtml).some(src => src.startsWith("case_joonghee.js")));
  // 예전 새 화면 주소는 기본 화면으로 보낸다.
  assert.match(read("frontend/index_joonghee.html"), /http-equiv="refresh" content="0; url=\/"/);
});

test("화면용 요약: 적용 기준·나이·확인 항목을 구조로 알려주고 결과 뒤에 이벤트를 보냄", async () => {
  const page = createPage({symptom: {category_id: "seizure", secondary_category_id: null, symptom_keywords: [], is_child: null, max_minutes: null, age_months: 30}});
  await start(page);
  const events = [];
  page.run("document").addEventListener("medinavi-recommend-done", event => events.push(event.detail));
  const guides = [];
  page.run("document").addEventListener("medinavi-guide-change", event => guides.push(event.detail));
  await searchSymptom(page, {flags: ["seizing"], age: [2, "세"]});
  const summary = JSON.parse(JSON.stringify(guides.at(-1)));   // 시험 화면(vm) 안에서 만든 값을 바깥 값으로
  assert.strictEqual(summary.level, "지역응급의료기관 이상");
  assert.strictEqual(summary.ageText, "2세(소아)");
  assert.strictEqual(summary.severity, "severe");
  assert.deepStrictEqual(summary.guides.map(item => item.title), ["경련 중 → 가장 가까운 지역응급의료기관 이상"]);
  assert.deepStrictEqual(summary.flags.map(flag => [flag.id, flag.checked]), [["seizing", true], ["pregnant", false]]);
  const done = JSON.parse(JSON.stringify(events.at(-1)));
  assert.strictEqual(done.level, "지역응급의료기관 이상");
  assert.match(done.notes.join(" "), /항경련제/);
  assert.strictEqual(done.counts.recommended, page.buttonsIn("recommend-results").length);
  assert.deepStrictEqual(page.run("window.medinaviRecommend.lastResult()").level, "지역응급의료기관 이상");
});


test("병원 자료: 외상센터 지정 정보가 반영돼 있고 실제 권역외상센터가 표시됨", () => {
  // tools/refresh_hospitals.py --write 로 반영한 값 (국립중앙의료원 외상센터 목록)
  const centers = hospitalsRaw.items.filter(item => item.trauma_center === true).map(item => item.dutyName);
  assert.ok(hospitalsRaw.items.every(item => typeof item.trauma_center === "boolean"), "모든 기관에 외상센터 여부가 있어야 해요");
  assert.ok(centers.length >= 1, "외상센터가 하나도 없어요");
  assert.ok(centers.some(name => name.includes("원주세브란스")), centers.join(","));
});
// ---------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const {name, body} of tests) {
    try {
      await body();
      console.log("ok   " + name);
    } catch (error) {
      failed += 1;
      console.log("FAIL " + name + "\n     " + (error.stack || error).toString().split("\n").slice(0, 3).join("\n     "));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 통과`);
  process.exit(failed ? 1 : 0);
})();
