# [기능 개발 계획서] 출석·당근 현황판 회원별 적립/소모 내역(History) 조회

> **문서 상태**: Rev.2 — 코드 대조 검토 반영본 (구현 착수 가능)
> **작성 일자**: 2026-09-05 / **개정**: 2026-09-05
> **대상 프로젝트**: 성북구 중상급 영어회화 사이트 (`index.html`)
> **구현 담당**: Antigravity

---

## 0. Rev.1 대비 변경점 (⚠️ 먼저 읽을 것)

초안을 실제 코드와 대조한 결과 아래 7건을 수정했다. **초안 기준으로 이미 작성된 코드가 일부 있으므로 §0.2 부터 처리한다.**

### 0.1 변경 요약

| # | 초안 | Rev.2 | 이유 |
| :-- | :--- | :--- | :--- |
| 1 | 변경 지점 **9개** (만료 포함) | **8개** — `expireStaleCoins` 제외 | 해당 함수는 리더 검사 없이 **모든 접속 기기**에서 Firestore 에 쓴다. `HANDOFF.md` 가 금지한 패턴 |
| 2 | `coinHistory` 배열 통째로 덮어쓰기 | **`arrayUnion(tx)`** 로 append | 기기 2대가 동시에 쓰면 한쪽 기록이 조용히 유실됨 |
| 3 | 최근 25건 롤링 캡 (`slice(-25)`) | **캡 제거**, 저장은 무제한 / **모달 렌더에서만 25건 자르기** | 용량 걱정이 실재하지 않음(연 100건 ≈ 13KB). arrayUnion 과 양립 불가 |
| 4 | `delta` = 조정 요청량(`amount`) | **`delta = newCoins - prevCoins`** | 당근 수량이 `Math.max(0, ...)` 로 잘려서 요청량 ≠ 실제 변동량 |
| 5 | 헬퍼가 `member.coins` 를 읽어 `balance` 산출 | **`prevCoins`, `newCoins` 를 인자로 받음** | 호출 순서에 따라 balance 가 한 칸 밀리는 함정 제거 |
| 6 | `resetAllCoins` 함수 연동 | **그런 함수 없음** — 인라인 콜백 위치 명시 | 이름 붙은 함수가 아님 |
| 7 | `reason` 자유 문자열 | **고정 문자열 목록에서만** 선택 | 내역이 전 회원에게 공개됨 |

### 0.2 이미 작성된 코드 — 수정 후 진행

아래는 초안 기준으로 이미 `index.html` 에 들어가 있다. **§4.2 의 새 시그니처로 고친 뒤** 나머지를 구현한다.

- `appendCoinHistory()` — 시그니처 교체, `slice(-25)` 제거, `tx` 반환 추가
- `formatCoinDate()` — 그대로 두면 됨
- `checkInOnTime` / `checkInReview` 호출부 2곳 — 새 시그니처 + `arrayUnion` 페이로드로 교체
- `coinHistoryModal` 모달 HTML — 그대로 두면 됨 (JS 함수는 아직 미구현)

---

## 1. 개요 및 요구사항

### 1.1 배경
- 현재 '출석·당근 현황판(Tab 3)'에는 각 회원의 총 출석 회차와 현재 보유 당근 수(0~6개), 당근 슬롯 아이콘만 표시된다.
- 회원 입장에서 "내가 언제 제시간 도착으로 받았는지", "언제 후기 작성으로 받았는지", "언제 6개를 써서 무료 참가를 했는지" 등 **상세 변동 내역**을 확인할 수 없어 운영자에게 구두로 문의하는 경우가 발생한다.

### 1.2 목표
- **Tab 3 현황판에서 회원 이름 터치 시**, 해당 회원의 **당근 적립/사용/차감 내역(일시, 변동량, 사유, 변동 후 잔여 당근)** 을 보여주는 팝업 모달을 제공한다.
- **불필요한 통신 및 비용 제로**: 모달 열람 시 추가 Firestore 쿼리나 쓰기가 일절 발생하지 않는 순수 읽기 전용 UI.
- **사이드 이펙트 제로**: 기존 키오스크 출석체크, 관리자 당근 조정, 30일 만료 자동 판정에 런타임 에러를 유발하지 않는다.

---

## 2. 현행 데이터 모델 분석 및 제약

### 2.1 현재 Firestore 회원 문서 구조 (`members/{memberId}`)
```javascript
{
  id: "abc-123",
  name: "홍길동",
  coins: 4,                  // 현재 잔여 당근 수만 존재 (단일 스냅샷)
  totalAttended: 5,
  lastAttendedAt: "2026-09-01T10:00:00.000Z",
  lastAction: "제시간 (+1당근)", // 가장 마지막 1건의 액션 라벨만 존재
  updatedAt: "2026-09-01T10:00:00.000Z"
}
```

### 2.2 과거 거래 내역의 한계 및 처리 정책
- **과거 데이터 부재**: 지금까지의 획득·소모 일시 및 사유 로그는 DB에 없다.
- **초기 베이스라인 정책**:
  - 기존 회원 문서에 `coinHistory` 필드가 없으면 빈 배열 `[]` 로 취급한다.
  - 내역이 없는 상태에서 모달을 열면 `기록된 당근 적립/소모 내역이 없습니다. (앞으로 활동 시 실시간 기록됩니다)` 문구를 노출한다.
  - **마이그레이션 스크립트를 돌리지 않는다.** 앞으로 발생하는 거래부터 누적한다.
  - ⚠️ 일회성 데이터 패치 코드를 `index.html` 에 넣지 말 것 — `HANDOFF.md` 의 "다시 손대지 말 것" 항목.

---

## 3. 아키텍처 비교 및 저장 방식 선정

| 비교 항목 | 방안 A: 회원 문서 내 배열 (선정 ⭐) | 방안 B: Firestore 서브컬렉션 |
| :--- | :--- | :--- |
| **저장 위치** | `member.coinHistory = [...]` (회원 문서 내부) | `members/{id}/history/{txId}` |
| **읽기 비용** | 기존 `onSnapshot(membersCollectionRef)` 에 자동 포함 → **추가 읽기 0회** | 이름 누를 때마다 조회 → 요금·트래픽 증가 |
| **반응 속도** | 이미 `membersData` 에 캐시 → **즉시 팝업** | 네트워크 대기, 로딩 스피너 필요 |
| **오프라인** | `localStorage('localMembersData')` 로 오프라인 조회 가능 | 별도 캐시 정책 필요 |
| **동시 쓰기 안전성** | **`arrayUnion` 사용 시 서버 병합 — 유실 없음** (§7 위험 1) | 문서가 분리되어 애초에 충돌 없음 |
| **문서 용량** | 연 100건 ≈ 13KB, 1MB 한도의 1.3% — 캡 불필요 | 무제한 |
| **보안/권한** | 기존 익명 Auth 규칙 그대로 | 서브컬렉션용 규칙 추가 필요 |

👉 **결론**: 2개 정적 파일 기반의 가벼운 아키텍처이므로 **방안 A (회원 문서 내 배열 + `arrayUnion` append)** 를 채택한다.

---

## 4. 데이터 스키마 및 공통 헬퍼 설계

### 4.1 거래 내역 스키마 (`CoinTransaction`)
```typescript
interface CoinTransaction {
  id: string;          // 고유 키 (예: 'tx_1725523200000_3x8a')
  date: string;        // ISO 8601 일시
  delta: number;       // 실제 변동량 (newCoins - prevCoins). 클램핑 반영값
  reason: string;      // §5.2 고정 문자열 목록 중 하나
  balance: number;     // 변동 후 최종 잔여 수량 (= newCoins)
  type: 'earn' | 'use' | 'admin'; // 적립 / 사용 / 관리자조정
}
```
> `expire` 타입은 §5 에서 만료 연동을 제외했으므로 사용하지 않는다.

### 4.2 공통 캡슐화 헬퍼 (`appendCoinHistory`)

**모든 당근 수량 변경부는 배열을 직접 조작하지 않고 이 헬퍼만 거친다.**
`prevCoins` / `newCoins` 를 받으므로 **호출 순서와 무관하게** 항상 올바른 `delta` 와 `balance` 가 나온다.

```javascript
// index.html — persistMembers 부근 (현재 2453줄 근처, 기존 함수를 이걸로 교체)

// 로컬 배열에 즉시 반영하고, Firestore 페이로드에 넣을 tx 객체를 돌려준다.
// 반환값이 null 이면 기록할 변동이 없다는 뜻이므로 페이로드에 coinHistory 를 넣지 않는다.
function appendCoinHistory(member, prevCoins, newCoins, reason, type = 'earn') {
    if (!member) return null;

    const before = parseInt(prevCoins, 10) || 0;
    const after  = parseInt(newCoins, 10) || 0;
    const delta  = after - before;
    if (delta === 0) return null;   // 실제 변동이 없으면 기록하지 않는다

    // 방어 코드: 기존 회원 문서에 coinHistory 필드가 없어도 죽지 않는다
    if (!Array.isArray(member.coinHistory)) {
        member.coinHistory = [];
    }

    const tx = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        date: new Date().toISOString(),
        delta: delta,
        reason: reason || '당근 변동',
        balance: after,
        type: type
    };

    member.coinHistory.push(tx);   // 화면 즉시 반영용 (Firestore 쓰기는 호출부에서 arrayUnion)
    return tx;
}
```

> **`slice(-25)` 를 넣지 않는다.** 저장은 무제한이고, 화면에 25건만 보이도록 자르는 것은 모달 렌더 함수의 책임이다(§6.2). 배열을 로컬에서 자른 뒤 `arrayUnion` 으로 보내면 서버 데이터와 어긋난다.

### 4.3 Firestore 쓰기 규약 (⚠️ 필수)

`coinHistory` 는 **절대 배열 통째로 덮어쓰지 않는다.** 반드시 `arrayUnion` 으로 append 한다.

```javascript
// 임포트 추가 — 현재 2424줄, increment 옆에 arrayUnion 만 덧붙인다
import { getFirestore, collection, doc, onSnapshot, setDoc, updateDoc,
         deleteDoc, writeBatch, increment, arrayUnion } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
```

```javascript
// 모든 호출부의 공통 형태
const prev = member.coins || 0;
const newCoins = /* 각 함수의 계산 결과 */;
member.coins = newCoins;

const tx = appendCoinHistory(member, prev, newCoins, '제시간 도착 적립', 'earn');

const payload = { coins: newCoins, updatedAt: now /* , ... */ };
if (tx) payload.coinHistory = arrayUnion(tx);   // ← 배열 통째 대입 금지

await updateDoc(doc(membersCollectionRef, member.id), payload);
```

`arrayUnion` 은 `writeBatch` 안에서도 동작하므로 §5 의 일괄 처리 3건에도 같은 형태를 쓴다.

> 쓰기가 실패해도 로컬 배열에만 남은 유령 항목은 다음 `onSnapshot` 이 `membersData` 를 서버 기준으로 갈아끼울 때 자동으로 사라진다. 별도 롤백 코드가 필요 없다.

---

## 5. 수량 변경 지점 전수 조사 및 연동 가이드 (8개 포인트)

### 5.1 연동 대상

모든 함수가 `window.xxx = function` 형태로 선언되어 있다(`function xxx` 로 grep 하면 안 나옴). 줄 번호는 작업 시점에 밀릴 수 있으니 함께 적은 앵커 문자열로 찾는다.

| 번호 | 함수 / 위치 | 변동 | 기록 사유 · 타입 |
| :--- | :--- | :--- | :--- |
| **1** | `window.checkInOnTime` (약 3650줄)<br>*이미 구현됨 — 새 시그니처로 교체* | `coins + 1` | '제시간 도착 적립' · `earn` |
| **2** | `window.checkInReview` (약 3708줄)<br>*이미 구현됨 — 새 시그니처로 교체* | `coins + 1` | '후기 작성 적립' · `earn` |
| **3** | `window.panelHandleNoShow('cancel')` (약 4912줄) | `coins + 2` | '사전 취소 환급' · `earn` |
| **4** | `window.panelAdjustCoins` (약 4977줄) | `Math.max(0, coins + amount)` | • `amount === -6`: '1회 무료 스터디 사용' · `use`<br>• `delta > 0`: '관리자 당근 지급' · `earn`<br>• `delta < 0`: '관리자 당근 차감' · `admin` |
| **5** | `window.savePanelMemberEdit` (약 5020줄) | 입력값 ≠ 기존값 | '관리자 직접 수정' · `admin` |
| **6** | `window.bulkSetAllMemberCoins` (약 4278줄) | `m.coins = targetCoins` | '전체 당근 수 통일 설정' · `admin` (Batch) |
| **7** | `window.bulkAdjustMemberCoins` (약 4324줄) | `Math.max(0, coins + delta)` | '전체 일괄 지급/차감' · `admin` (Batch) |
| **8** | **이름 없는 인라인 콜백** — 전체 0개 초기화<br>앵커: `showToast("🥕 모든 회원의 당근이 0개로 초기화되었습니다."` (약 4229줄)<br>그 위 `onConfirm: async () => {` 블록 내부 `membersData.forEach` | `m.coins = 0` | '전체 시즌 당근 초기화' · `admin` (Batch) |

**제외 — `expireStaleCoins` (30일 만료, 약 4567줄):** §7 위험 2 참조. 이번 작업에서 **손대지 않는다.**

### 5.2 `reason` 고정 문자열 목록

내역은 전 회원에게 공개되므로 **관리자 자유 입력 텍스트를 `reason` 에 넣지 않는다.** 아래 목록 외의 문자열을 쓰지 말 것.

```
'제시간 도착 적립' / '후기 작성 적립' / '사전 취소 환급'
'1회 무료 스터디 사용'
'관리자 당근 지급' / '관리자 당근 차감' / '관리자 직접 수정'
'전체 당근 수 통일 설정' / '전체 일괄 지급/차감' / '전체 시즌 당근 초기화'
```

### 5.3 `delta` 계산 규칙 (⚠️ 4·6·7·8번에서 특히 주의)

`panelAdjustCoins` 와 `bulkAdjustMemberCoins` 는 `Math.max(0, ...)` 로 0에서 잘린다. **조정 요청량이 아니라 실제 변동량을 기록한다.**

```javascript
// ✗ 틀림 — 당근 2개인 회원에게 -3 하면 "-3, 잔여 0" 이라는 앞뒤 안 맞는 기록이 남는다
appendCoinHistory(member, ..., amount, ...);

// ✓ 맞음 — 헬퍼에 prev/new 만 넘기면 delta 는 자동으로 -2 가 된다
const prev = member.coins || 0;
const newCoins = Math.max(0, prev + amount);
member.coins = newCoins;
const tx = appendCoinHistory(member, prev, newCoins, reason, type);
```

일괄 처리(6·7·8)에서는 변동이 없는 회원에 대해 헬퍼가 `null` 을 돌려주므로, 그 회원의 페이로드에는 `coinHistory` 키를 넣지 않는다.

---

## 6. UI/UX 상세 설계

### 6.1 현황판 (Tab 3) 회원 이름 인터랙션

현재 이름 칸은 `<span class="member-name-text ...">` 이다(약 6600줄, 앵커: `w-[58px] sm:w-[84px]`). 이 `span` 을 `button` 으로 바꾼다. **상위 행 컨테이너에는 `onclick` 이 없으므로 이벤트 충돌은 없다.** 열 너비 클래스(`w-[58px] sm:w-[84px] shrink-0 truncate`)는 그대로 유지한다.

```html
<!-- Col 1: Member Name (Strict Column) -->
<div class="w-[58px] sm:w-[84px] shrink-0 truncate flex items-center">
    <button type="button"
            onclick="openCoinHistoryModal('${m.id}')"
            class="text-left font-bold text-xs sm:text-sm text-zinc-100 hover:text-amber-300 transition truncate cursor-pointer underline decoration-dotted decoration-zinc-600 underline-offset-2 hover:decoration-amber-300"
            title="${esc(m.name || '미지정')} (클릭 시 당근 내역 확인)">
        ${esc(m.name || '미지정')}
    </button>
</div>
```

### 6.2 당근 상세 모달 (`coinHistoryModal`)

모달 HTML 은 이미 작성되어 있다. 남은 것은 JS 함수 4개다: `openCoinHistoryModal(id)`, `closeCoinHistoryModal()`, `filterCoinHistory(mode)`, `renderCoinHistoryList()`.

1. **상단 헤더**: 주황 당근 아이콘 / 회원 이름 / `현재 보유: N개` / 6개 달성 시 `FREE PASS` 뱃지 / `✕`
2. **필터 탭 3종**: `[전체]` / `[적립 (+)]` / `[사용/차감 (-)]` — **`type` 이 아니라 `delta` 의 부호로 거른다** (`admin` 타입은 지급·차감 양쪽에 나타나므로).
3. **타임라인 리스트**:
   - **최신순 정렬 후 상위 25건만 렌더한다** (`[...list].reverse().slice(0, 25)`). 저장된 배열은 자르지 않는다.
   - `+` 변동은 초록, `-` 변동은 장미색 뱃지. 사유명, 일시(`09.05 10:00`), 변동량, 당시 잔여량 표시.
   - 진입부 방어: `const list = Array.isArray(member?.coinHistory) ? member.coinHistory : [];`
   - 빈 상태: `기록된 당근 적립/소모 내역이 없습니다. (앞으로 활동 시 실시간 기록됩니다)`
4. **하단 닫기 버튼**: 모바일 풀 위드. 배경 딤 터치로도 닫힘.

---

## 7. 핵심 안전 수칙 및 리스크 방지 설계

### ⚠️ 위험 1: 동시 쓰기로 인한 기록 유실 (가장 중요)

- **원인**: 배열을 통째로 덮어쓰면 read-modify-write 경합이 발생한다.
  ```
  아이패드 키오스크: 내역 5건 읽음 → +1 append → 6건 쓰기
  리더 폰(동시):    내역 5건 읽음 → -6 append → 6건 쓰기   ← 키오스크 기록 증발
  ```
  `coins` 는 숫자 하나라 last-write-wins 로도 견디지만, 배열은 **기록이 조용히 사라진다.**
- **방지책**: §4.3 대로 `coinHistory: arrayUnion(tx)` 로만 쓴다. Firestore 가 서버에서 병합하므로 두 기기의 기록이 모두 남는다. 각 `tx.id` 가 고유하므로 arrayUnion 의 중복 제거에 걸릴 일도 없다.
- **금지**: `coinHistory: member.coinHistory` / `coinHistory: [...member.coinHistory, tx]` / `coinHistory: member.coinHistory.slice(-25)`

### ⚠️ 위험 2: 만료 함수(`expireStaleCoins`)에 손대면 안 되는 이유

- **현황**: 이 함수는 `coinExpiryChecked` 라는 **메모리 플래그만** 걸려 있고 리더 검사가 없다(약 4474줄 호출). 즉 **회원 폰을 포함한 모든 접속 기기에서 실행되며 그 자리에서 Firestore 에 쓴다.**
- **위험**: 여기에 히스토리 기록을 추가하면 접속한 기기 수만큼 만료 트랜잭션이 중복 생성되거나 서로 덮어쓴다. `HANDOFF.md` 의 "다시 손대지 말 것 — 리더 검사 없이 모든 기기에서 Firestore 에 쓰던 마이그레이션 블록" 과 **정확히 같은 형태**다.
- **방지책**: **이번 작업에서 `expireStaleCoins` 를 수정하지 않는다.** 만료 사실은 이미 `coinsBeforeExpiry` / `coinsExpiredAt` 필드로 남고 있다. 히스토리에도 남기고 싶다면 `expireStaleCoins` 자체를 리더 전용으로 게이팅하는 **별도 선행 작업**으로 다룬다.

### ⚠️ 위험 3: 키오스크 체크인 크래시 (TypeError: undefined)

- **원인**: 기존 DB 문서에 `coinHistory` 필드가 없어 `member.coinHistory.push()` 가 즉시 예외를 던지면 체크인이 멈춘다.
- **방지책**: `if (!Array.isArray(member.coinHistory)) member.coinHistory = [];` 를 **헬퍼 진입부와 모달 렌더 함수 진입부 양쪽**에 둔다.

### ⚠️ 위험 4: 회원 기기에서의 무단 Firestore 쓰기

- **방지책**: `openCoinHistoryModal()` 은 메모리의 `membersData` 를 필터링해 DOM 에 그리는 **순수 읽기 함수**다. `setDoc` / `updateDoc` 을 절대 호출하지 않는다.
- ⚠️ 단, 위험 2 때문에 "회원 기기는 아무것도 쓰지 않는다" 는 **현재 코드에서 사실이 아니다.** 이 기능이 그 상태를 악화시키지 않도록 하는 것이 목표다.

### ⚠️ 위험 5: 내역 공개 범위

- 현황판은 전 회원에게 공개되고, 이름을 누르면 **누구나 남의 내역을 볼 수 있다.** 이미 당근 수는 공개되어 있으므로 허용 가능한 수준이지만, `reason` 문자열이 그대로 노출된다.
- **방지책**: §5.2 고정 문자열 목록만 사용. 관리자 메모·사유 자유 입력을 `reason` 에 넣지 않는다.

### 문서 용량은 위험이 아니다

회원 1명이 연 100건을 쌓아도 약 13KB 로 Firestore 1MB 한도의 1.3% 다. **롤링 캡을 넣지 않는다** (위험 1 과 충돌한다).

---

## 8. 검증 및 테스트 계획

1. **구문 정적 분석** — `node --check index.html` 은 HTML 이라 실패한다. 가장 큰 `<script type="module">` 블록을 `.mjs` 로 추출한 뒤 검사한다:
   ```bash
   python3 -c "
   import io,re
   s=io.open('index.html',encoding='utf-8').read()
   m=max(re.findall(r'<script type=\"module\">(.*?)</script>',s,re.S),key=len)
   io.open('/tmp/mod.mjs','w',encoding='utf-8').write(m)
   " && node --check /tmp/mod.mjs
   ```
2. **키오스크 적립** — 제시간 도착 클릭 시 `+1` 과 함께 모달에 1건 누적되는지.
3. **관리자 6당근 소모** — `-6` 처리 시 `-6 당근 (1회 무료 스터디 사용)` 이 정확히 기록되는지.
4. **클램핑 검증** — 당근 2개인 회원에게 `-3` 조정 시 내역이 **`-2`, 잔여 0** 으로 남는지 (`-3` 이면 실패).
5. **동시 쓰기 검증** — 브라우저 2개(또는 아이패드+폰)에서 같은 회원에게 각각 다른 적립을 거의 동시에 실행한 뒤, **두 기록이 모두 남아 있는지.** 하나가 사라지면 `arrayUnion` 이 적용되지 않은 것.
6. **롤오버 표시** — 특정 회원의 `coinHistory` 에 30건을 넣어두고 모달이 최신 25건만 그리는지, 저장된 배열은 30건 그대로인지.
7. **일반 회원 뷰** — 모바일에서 Tab 3 이름 터치 → 모달 정상 오픈, 필터 3종 동작. 이때 **네트워크 탭에 Firestore 쓰기 요청이 0건**인지.
8. **신규/빈 데이터** — `coinHistory` 가 없는 기존 회원의 모달이 크래시 없이 빈 상태 문구를 띄우는지.
9. **새로고침** — `localStorage` 캐시로 직전 내역이 유지되는지.
