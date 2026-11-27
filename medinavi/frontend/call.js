// 병원에 바로 전화 걸기 버튼 (휴대폰에서 누르면 전화 앱이 번호를 채워서 열린다).
// 시험 모드: 주소 끝에 ?call_test=010xxxxxxxx 를 붙여 접속하면, 이 탭에서는 모든 전화 버튼이 그 번호로 걸린다.
//  - 실제 병원에 장난전화가 가지 않게 버튼 동작을 확인하기 위한 기능이다.
//  - 번호는 코드·서버에 남기지 않고 이 탭의 sessionStorage에만 둔다 (탭을 닫으면 사라짐).
//  - 다른 사람이 보낸 주소로 전화가 엉뚱한 곳에 걸리지 않도록 휴대폰 번호(010 등)만 받고, 화면 위에 항상 알린다.
//  - ?call_test=off 또는 화면의 '시험 모드 끄기'로 끈다.
(function () {
  const STORAGE_KEY = "medinavi-call-test";
  const PARAM = "call_test";

  function digits(phone) {
    return String(phone ?? "").replace(/[^0-9]/g, "");
  }
  // 시험 번호는 휴대폰 번호만 받는다 (060 같은 유료 번호 차단).
  function validTestNumber(value) {
    const number = digits(value);
    return /^01[016789]\d{7,8}$/.test(number) ? number : "";
  }
  // 공공데이터 전화번호를 걸 수 있는 숫자로 바꾼다. 걸 수 없으면 "".
  // 예: "031-574-9118~9" → 0315749118 (뒤 범위 표기 제거), "031-1644-9118" → 16449118 (대표번호 앞 지역번호 제거), "1661-7500" → 16617500
  function dialable(phone) {
    const text = String(phone ?? "").split(/[~,/]/)[0].trim();
    // 지역번호와 대표번호(15xx·16xx·18xx)가 구분 기호로 나뉘어 있을 때만 지역번호를 뺀다 (031-8285000 같은 일반 번호는 그대로).
    const tollFree = /^0\d{1,2}[-) ]+(1[5-9]\d{2})[- ]?(\d{4})$/.exec(text);
    const number = tollFree ? tollFree[1] + tollFree[2] : digits(text);
    return /^0\d{8,10}$/.test(number) || /^1[5-9]\d{6}$/.test(number) ? number : "";
  }
  function pretty(number) {
    if (number.length === 8) return number.slice(0, 4) + "-" + number.slice(4);
    if (number.startsWith("02")) return "02-" + number.slice(2, -4) + "-" + number.slice(-4);
    if (number.length === 11) return number.slice(0, 3) + "-" + number.slice(3, 7) + "-" + number.slice(7);
    if (number.length === 10) return number.slice(0, 3) + "-" + number.slice(3, 6) + "-" + number.slice(6);
    return number;
  }
  function storage() {
    try { return window.sessionStorage || null; } catch (error) { return null; }
  }
  function saveTestNumber(number) {
    const store = storage();
    try { number ? store?.setItem(STORAGE_KEY, number) : store?.removeItem(STORAGE_KEY); } catch (error) { /* 저장 불가: 이 화면에서만 적용 */ }
  }

  let testNumber = "";
  // 주소의 call_test 값을 읽고, 번호가 주소창·방문 기록에 남지 않도록 주소에서 지운다.
  function readAddress() {
    const search = String(window.location?.search || "");
    const params = new URLSearchParams(search);
    if (params.has(PARAM)) {
      const value = params.get(PARAM) || "";
      testNumber = value === "off" ? "" : validTestNumber(value);
      saveTestNumber(testNumber);
      params.delete(PARAM);
      try {
        const rest = params.toString();
        window.history?.replaceState?.(null, "", window.location.pathname + (rest ? "?" + rest : "") + (window.location.hash || ""));
      } catch (error) { /* 주소 정리 실패는 무시 */ }
      return value !== "off" && !testNumber;   // 잘못된 번호였는지
    }
    try { testNumber = validTestNumber(storage()?.getItem(STORAGE_KEY)); } catch (error) { testNumber = ""; }
    return false;
  }

  function renderBanner(invalid) {
    const banner = document.querySelector("#call-test-banner");
    if (!banner) return;
    banner.replaceChildren();
    banner.textContent = "";
    if (testNumber) {
      banner.textContent = "전화 시험 모드: 이 탭의 모든 전화 버튼이 병원 대신 " + pretty(testNumber) + "(으)로 걸려요. ";
      const off = document.createElement("button");
      off.type = "button";
      off.textContent = "시험 모드 끄기";
      off.onclick = () => setTestNumber("");
      banner.append(off);
      banner.hidden = false;
    } else if (invalid) {
      banner.textContent = "전화 시험 모드를 켜지 못했어요. 주소 끝에 ?call_test=01012345678 처럼 휴대폰 번호를 넣어 주세요.";
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // 화면에 이미 그려진 전화 버튼도 바뀐 번호로 맞춘다.
  const links = new Set();
  function applyTarget(link) {
    const real = link.dataset.phone;
    const target = testNumber || real;
    link.href = "tel:" + target;
    link.textContent = testNumber ? "📞 전화 (시험: " + pretty(testNumber) + ")" : "📞 전화 " + link.dataset.display;
    link.dataset.test = testNumber ? "true" : "";
  }
  function setTestNumber(value) {
    testNumber = value ? validTestNumber(value) : "";
    saveTestNumber(testNumber);
    renderBanner(false);
    for (const link of links) {
      if (link.isConnected === false) links.delete(link);   // 지워진 결과 목록의 버튼은 정리
      else applyTarget(link);
    }
  }

  // 병원의 응급실 번호(dutyTel3), 없으면 대표번호(dutyTel1)로 전화 버튼을 만든다. 번호가 없으면 null.
  function link(hospital) {
    const er = String(hospital?.dutyTel3 || "").trim();
    const main = String(hospital?.dutyTel1 || "").trim();
    const raw = er || main;
    const number = dialable(raw);
    if (!number) return null;
    const shown = digits(raw) === number ? raw : pretty(number);
    const anchor = document.createElement("a");
    anchor.className = "call-link";
    anchor.dataset.phone = number;
    anchor.dataset.display = (er ? "응급실 " : "대표번호 ") + shown;
    anchor.setAttribute("aria-label", (hospital.dutyName || "병원") + " " + (er ? "응급실" : "대표번호") + "에 전화 걸기");
    applyTarget(anchor);
    links.add(anchor);
    return anchor;
  }

  // 목록 한 줄(li)에 전화 버튼을 붙인다.
  function attach(item, hospital) {
    const anchor = link(hospital);
    if (anchor) item.append(anchor);
    return anchor;
  }

  const invalid = readAddress();
  renderBanner(invalid);
  window.medinaviCall = {link, attach, setTestNumber, testNumber: () => testNumber, validTestNumber, dialable, pretty};
})();
