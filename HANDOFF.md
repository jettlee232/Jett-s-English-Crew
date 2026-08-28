# 작업 지시 (갱신 2026-08-28) — 성북구 중상급 영어회화 사이트

## 전제
정적 사이트 2파일(`index.html`, `worksheet.html`) + Firebase(Firestore/익명auth).
빌드 없음, 번들러 없음, 의존성 추가 금지. **최소 diff.**
저장소 public, GitHub Pages 배포. 프로덕션 실데이터(회원 103명).
백업: `firestore-backup-2026-08-25.json` (gitignore됨).

**라이브 = `5a46354` (푸시·배포 반영 완료). 로컬과 원격 동일.**

> ⚠️ **회원들이 각자 폰으로 사이트에 접속한다.** 어떤 코드든
> "처음 접속하는 기기에서 자동으로 Firestore 에 쓰는" 형태로 만들지 말 것.
> localStorage 키는 기기별이라 가드가 되지 않는다. (2026-08-28 사고 직전 제거, 아래 참조)

---

## 🪑 자리 배치 시스템 (2026-08-28 전면 개편 — 여기부터 읽을 것)

### 데이터 흐름

```
리더 기기 ── 생성/수정 ──▶ Firestore  settings/seating ──▶ 회원 기기 (구독 전용)
     │                          ▲                              │
     └─ localStorage 캐시 ──────┘  (오프라인/새로고침 폴백)  ──┘
```

- **좌석 문서**: `artifacts/{appId}/public/data/settings/seating` (`index.html:2324`)
  `{ date, isPart2Shuffle, p1:[[id...]...], p2:[...], updatedAt }` — 회원 **id 배열만** 저장한다.
- **게시**: `publishSeatingPlan()` (`index.html:3544`). **리더 기기만**(`isLeaderAuthenticated`)
  쓰고, 직전 게시 내용과 서명이 같으면 쓰지 않는다(렌더마다 쓰지 않기 위함).
- **구독**: `onSnapshot(seatingDocRef, ...)` (`index.html:5322`) → `applySeatingDoc()` (`index.html:3521`)
- **로컬 캐시**: `SEATING_CACHE_KEY = 'seatingSnapshots_v2'` (`index.html:3498`),
  `persistSeatingSnapshots()` / `loadSeatingSnapshots()`. 날짜가 바뀌면 자동 폐기.
- **호출 지점은 한 곳**: `renderSeatingPlan()` 안의
  `currentSeatingTables = tables;` 직후에 `persistSeatingSnapshots(); publishSeatingPlan();`
  스냅샷이 바뀌면 반드시 렌더가 뒤따르므로 생성·재배치·셔플·수동이동·조기퇴장이 전부 덮인다.
  **여기에 저장 호출을 더 추가하지 말 것.**

### 반드시 지켜야 하는 4가지 (전부 실제로 터졌던 버그다)

1. **회원 기기는 좌석을 생성하지 않는다.**
   `renderSeatingPlan()` 의 `else if (!isLeaderAuthenticated)` 분기에서 안내 문구를 띄우고 return.
   이걸 없애면 기기마다 다른 자리가 나온다(회원들이 각자 폰으로 보므로 바로 사고).
2. **`membersData` 가 비었을 때 좌석 문서를 반영하지 않는다.**
   `applySeatingDoc()` 은 hydrate 결과 인원 수가 원본 id 개수와 다르면
   `pendingSeatingDoc` 에 보류하고 반영을 미룬다.
   좌석은 문서 1개 구독이고 회원은 103개 컬렉션 구독이라 좌석이 먼저 도착하는 일이 흔하다.
   빈 껍데기로 덮으면 좌석 문서가 다시 발화하지 않아 **복구 경로가 없다.**
   보류분은 `renderSeatingPlan()` 진입부(서버 → 로컬 캐시 순 복원 블록)에서 자동 반영된다.
3. **Firestore 에 중첩 배열(배열 안의 배열)을 넣지 마라.**
   좌석은 `[[id,id,id],[id,id,id]]` 모양이라 그대로는 저장이 **불가능**하다.
   `seatingEncode()` / `seatingDecode()` 로 **JSON 문자열**로 바꿔 넣는다.
   그대로 넣으면 `setDoc()` 이 네트워크로 나가기도 전에 **동기적으로 예외를 던지고**,
   그 예외가 `renderSeatingPlan()` 을 중단시켜 **테이블이 아예 안 그려진다.**
   `.catch()` 는 Promise 거부용이라 이 예외를 못 잡는다.
   그래서 `publishSeatingPlan()` 전체가 `try/catch` 로 감싸여 있다 — **풀지 말 것.**
   게시 실패는 조용히 넘어가고 화면 표시는 계속돼야 한다.

   > 이 버그는 증상이 기묘했다. 첫 렌더만 죽고, 아무 버튼이나 눌러 렌더를 한 번 더 태우면
   > 정상 표시됐다(서명을 setDoc 전에 갱신해서 두 번째부터는 early return 됐기 때문).
   > 게다가 호출 경로의 빈 `catch(e) {}` 가 예외를 삼켜 **콘솔에 아무 흔적도 안 남았다.**
   > **빈 `catch(e) {}` 를 새로 만들지 말 것.** 최소한 `console.warn` 은 남겨라.

4. **좌석 스냅샷은 메모리 변수다.** `part1SeatingSnapshot` / `part2SeatingSnapshot` /
   `isPart2Shuffle` 은 새로고침하면 사라진다. 위 캐시·구독이 그걸 메운다.
   스냅샷을 `null` 로 만드는 코드를 새로 추가하지 말 것(주제 저장은 순서 모드가 바뀐 경우에만 초기화한다).

### 1부(믹스) 필터 우선순위 — 이 순서가 리더 확정 사항이다

| 순위 | 필터 | 가중치 | 위치 |
|---|---|---|---|
| 1 | **T1 = 리더 + 첫 참석자 고정** | 하드(배정 단계) | `generateMixSeatingPlan` T1 채우기 |
| 2 | 같은 연령대 동석 금지 | 50000 | `getMixCost` / `evaluateTableMix` |
| 3 | 커플 분리 (`AVOID_COUPLE_PAIRS`) | 9000 | `isAvoidPair` (`index.html:6203`) |
| 4 | 과거 만남 회피 | 800 | `getPairMeetingCount` |
| 5 | 나이 평균 평준화 | 120 / 200 | tie-breaker. **올리지 말 것** |
| 6 | 성비 균형 | 45 | |

- **1이 2보다 위다.** 리더(Jett, 30대)와 같은 연령대인 첫 참석자도 T1 에 넣는다.
  그래서 T1 에서만 세대 중복이 생긴다 — 의도된 대가이고 버그가 아니다.
- 2를 하드 금지로 바꾸지 말 것. 명단이 20대(32명)·30대(36명)에 몰려 있어
  12명 표본의 약 75% 는 완전 분리가 **이론상 불가능**하다(비둘기집).
  큰 가중치로 두어야 불가능할 때 자동으로 최소 위반을 찾는다.
- 5를 1500/2500 으로 올렸던 적이 있는데, 실측상 60 이상은 결과 차이가 없고
  과거 만남 회피만 28% 나빠졌다. 되돌린 값이 현재 값이다.

**2026-08-28 실측 (8/29 참석자 12명, 1부 믹스 500회)**
`T1 = 리더+신규2명 100%` / `동일연령대 동석 — T1 1.00쌍, T2~T4 0.00쌍` / `커플 동석 0`
알고리즘을 건드렸으면 이 수치를 다시 뽑아 회귀를 확인할 것.

### 2부(또래)
같은 세대를 **모으는** 것이 목적이다. 20대를 흩뜨리는 페널티가 있었는데 목적과 정면 충돌해서 제거했다.
다시 넣지 말 것. 1부에서 이미 세대를 갈라놨으므로 2부에서 모이는 게 정상이다.

### 순서 모드
`topicData.seatingOrderMode` = `mix_first`(기본) / `peer_first`.
전환 경로는 `requestToggleSeatingOrderWithPin()` **하나뿐**이다.
설정 패널의 두 버튼(`setSeatingOrderMode`)도 이 함수로 위임한다. 별도 경로를 만들지 말 것.

---

## ✅ 완료 — 다시 손대지 말 것

**`ab825b6` 클라이언트 마이그레이션 블록 4개 제거 (P0 사고 예방)**
- `topic_sync_20260826_daangn_v3` / `roster_sync_20260826_coins_v5` /
  `study_attendees_sync_20260829_v6` / `roster_attendance_fix_20260826_v1`
- 전부 localStorage 키로만 가드되고 리더 검사가 없어, **처음 접속하는 모든 기기**에서
  실행되며 그 자리에서 Firestore 에 썼다(참석자 당근 0 리셋 / `totalAttended` 롤백 /
  회원 `deleteDoc` / 주제 덮어쓰기). 회원 폰 12대가 접속하면 12번 반복될 상황이었다.
- **같은 형태의 코드를 다시 만들지 말 것.** 일회성 데이터 패치는 리더가 관리자 UI·CSV 로 한다.

**`5a46354` 좌석이 아예 표시되지 않던 버그 (Firestore 중첩 배열)** → 위 "반드시 지켜야 하는 4가지" 3번

**`e3a30da` 좌석 문서–회원 명단 도착 경합** → 위 "반드시 지켜야 하는 4가지" 2번

**`69f5a8d` 좌석 Firestore 공유** — 회원 기기가 각자 배치를 생성해 자리가 서로 달랐던 문제

**`ee723f5` 신규 첫 참석자 T1 고정을 최우선으로**
`isNewbieMember` 는 `(m.totalAttended || 0) === 0` — **첫 참석 1회만**이다.
당일 게스트 등록은 `totalAttended: 0` 으로 만든다(마감 시 +1 되어 1이 된다). 1로 되돌리지 말 것.

**`83ca8e4` 빈 테이블 필터 위치** — `currentSeatingTables` 대입 **앞**에 있어야 한다.
뒤에 두면 화면 인덱스와 `seatTapTable(idx)` 인덱스가 어긋나 회원이 사라진다.

**그 이전 (같은 날 검수 반영분)**
- 교환 루프가 T1 에서 조기 종료되던 버그(`if (improved) break;`) — 1부 최적화가 200회 중 0건 실행되고 있었다
- 교환 제외 대상을 "신규 전원" → `lockedIds`(실제로 T1 에 앉힌 사람)로 축소
- 조기 퇴장 1명에 배치가 통째로 날아가던 문제 → 세션 중 테이블 개수 고정, 스냅샷 무결성 검사로 전환
- 만남 이력 멱등 저장(`${date}-p${part}`), `getPairMeetingCount` 에서 오늘 세션 제외
- 1부 재배치 🎲 버튼(`requestRerollPart1WithPin`, `index.html:7172`)

**더 이전**
- `worksheet.html` / `index.html` `color-scheme` 선언 (모바일 다크테마 PDF 검은 화면)
- 리더 PIN 게이트 및 후속 결함 3건 (회원은 항상 `teaser` 2p)
- Firestore 규칙 게시 완료. `firestore.rules` 는 콘솔에 붙여넣은 사본이다.
  좌석은 `settings` 컬렉션을 쓰므로 **규칙 수정 불필요**.

---

## 🟢 P2 — 스튜디오 발행본 불러오기 (판단만)

`worksheet.html` DOMContentLoaded: `loadLocalState()` 실패 시에만 `loadSampleData()`.
결과: 리더 기기는 localStorage 의 지난 작업분, 새 기기는 데모 샘플이 뜬다.
발행본을 이어서 편집하는 경로가 없음.
**코드 변경 전 리더에게 확인할 것.** 불필요하면 운영 안내로 대체 —
"매주 [비우기] 누르고 새 마크다운 붙여넣기".

## 🟢 P2 — 리더 계정 로그인 (오픈 이후)

리더 인증은 전부 클라이언트 사이드다. Firestore 규칙도 `request.auth != null` 까지만 요구하는데
익명 토큰은 누구나 발급받을 수 있다. 작정한 사람의 `members` 변조/삭제는 여전히 가능하다.
진짜 차단은 Firebase Auth 이메일/비번 + 규칙의 `request.auth.uid` 고정.
**운영이 안정된 뒤 별도 작업으로.**

## 🟢 P3 — 알아두면 좋은 것

- **커플 분리가 닉네임 하드코딩이다.** `AVOID_COUPLE_PAIRS = [["눅눅","펠메니"]]`.
  현재 명단에 부분일치 충돌 없음(확인함). 둘 중 한 명이 닉네임을 바꾸면 조용히 무력화된다.
  커플이 더 늘면 회원 데이터 필드로 뺄 것.
- **날짜는 전부 UTC 기준**(`new Date().toISOString().slice(0,10)`). 모임이 토 10:00 KST 라
  현재는 안전하지만, KST 00:00~09:00 사이 작업은 전날로 기록된다.
- **테이블 개수는 세션 중 고정된다.** 워크인이 몰리면(12→18) 기존 테이블에 4~5명씩 들어간다.
  🎲 재배치를 누르면 다시 계산된다.

---

## ⛔ 손대지 말 것 (검토 완료, 의도된 상태)
- Tailwind Play CDN: 프로덕션 경고 뜨지만 20명 규모에 빌드 붙일 이유 없음
- `material.pdf`: 690바이트 더미, 어디서도 로드 안 됨
- `console.log` / `alert()`: 전부 catch 블록 또는 의도된 관리자 도구
- 위 "✅ 완료" 항목 전부

## 완료 기준
- 콘솔 에러 0 (Tailwind CDN 경고 1건 허용)
- 390px 에서 두 페이지 모두 `documentElement.scrollWidth === clientWidth`
- 중복 ID 0, inline 핸들러 미정의 함수 0
- `@media print` 에서 `:root` colorScheme=light, 용지 `#fff`, 본문 `#000`
- 회귀 없음: 4개 탭 전환, PIN 모달, PDF 인쇄(6p/2p), 발행, 회원 리더 2p 잠금
- **자리 배치 회귀 시나리오**
  1. 리더 기기: 1부 생성 → 수동 이동 2건 → 새로고침 → 이동 결과까지 보존
  2. 시크릿창(회원 기기): 리더와 **같은 배치**가 보이고, 회원·당근·참석자·주제가 **하나도 바뀌지 않음**
  3. 리더가 2부 셔플 → 회원 기기도 2부로 따라옴
  4. 조기 퇴장 1명 → 테이블 개수 유지 → [1부 복원] 정상
  5. 당일 게스트 등록 → T1 배정 → 마감(출석 반영) → 다음 배치에서 T1 고정 해제
  6. [이력 저장] 2회 → 이력 카운트 1 증가
