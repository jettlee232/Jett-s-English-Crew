// 테이블 배치 규칙 자가 점검. 실행: node seating-check.js
// index.html 안의 배치 알고리즘을 그대로 떼어내 규칙 5개를 검사한다.
const fs = require('fs'), assert = require('assert');

const src = fs.readFileSync(__dirname + '/index.html', 'utf8');
const from = src.indexOf('function getPairMeetingCount');
const to = src.indexOf('function renderSeatingPlan');
assert.ok(from > 0 && to > from, 'index.html에서 배치 알고리즘을 찾지 못했습니다');
const build = new Function('history', 'snapshot',
    'let tableSessionsData = history, part1SeatingSnapshot = snapshot;'
    + src.slice(from, to) + 'return calculateSmartSeatingPlan;');

const M = (name, gender, ageGroup, extra = {}) => ({ id: name, name, gender, ageGroup, ...extra });
const today = [
    M('Jett', 'M', '30대', { isLeader: true }), M('Jackie', 'F', '50대'),
    M('대니얼', 'M', '40대'), M('DY', 'M', '30대'), M('Sunny', 'F', '50대'),
    M('Jun', 'M', '20대'), M('표토르', 'M', '50대'), M('Lucy', 'F', '40대'),
    M('Richard', 'M', '60대'), M('Elle', 'F', '30대', { isNew: true, lastAction: '신규 참석' }),
];
const N = 50;
const names = t => t.map(tb => tb.map(m => m.name));
const tableOf = (t, n) => t.find(tb => tb.some(m => m.name === n));

// 1. 정원: 전원 1회씩 배정, 테이블 인원 차이 1명 이하
for (let i = 0; i < N; i++) {
    const t = build([], null)(today, false);
    const all = names(t).flat();
    assert.strictEqual(all.length, today.length, '인원 수가 맞지 않음');
    assert.strictEqual(new Set(all).size, today.length, '중복 배정된 멤버가 있음');
    const sizes = t.map(tb => tb.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, '테이블 인원이 균등하지 않음: ' + sizes);
}

// 2. 리더·신규는 1부·2부 모두 1번 테이블 고정
for (let i = 0; i < N; i++) {
    for (const part2 of [false, true]) {
        const t = build([], null)(today, part2);
        assert.ok(t[0].some(m => m.isLeader), '리더가 T1에 없음');
        assert.ok(t[0].some(m => m.isNew), '신규가 T1에 없음');
    }
}

// 3. 20대가 1명뿐이면 반드시 30대와 같은 테이블
for (let i = 0; i < N; i++) {
    const t = build([], null)(today, false);
    assert.ok(tableOf(t, 'Jun').some(m => m.ageGroup === '30대'), '20대 1명이 30대 없이 배정됨');
}

// 4. 과거 만남 회피가 나이·성비 균형을 이긴다 (지난주 조합 1회만 있어도 깨진다)
const lastWeek = { tables: [['DY', 'Jackie', '대니얼'], ['Elle', 'Jett', 'Sunny', '표토르'], ['Jun', 'Lucy', 'Richard']] };
for (let i = 0; i < N; i++) {
    const t = names(build([lastWeek], null)(today, false)).map(tb => tb.slice().sort().join());
    for (const prev of lastWeek.tables) {
        assert.ok(!t.includes(prev.slice().sort().join()), '지난주 테이블이 그대로 재현됨');
    }
}

// 5. 2부는 비슷한 세대끼리 묶인다 (한 테이블의 나이대 폭 10년 이내)
const AGE = { '10대': 18, '20대': 25, '30대': 35, '40대': 45, '50대': 55, '60대': 65 };
const span = tb => Math.max(...tb.map(m => AGE[m.ageGroup])) - Math.min(...tb.map(m => AGE[m.ageGroup]));
for (let i = 0; i < N; i++) {
    const p1 = build([], null)(today, false);
    const p2 = build([], JSON.parse(JSON.stringify(p1)))(today, true);
    for (const tb of p2) assert.ok(span(tb) <= 10, '2부 테이블 세대 폭이 너무 넓음: ' + tb.map(m => m.name + m.ageGroup));
}

// 6. 같은 세대 안에서는 1부에 함께 앉았던 분을 피한다
//    (세대 폭을 넓히지 않으면서 1부 재만남을 줄일 수 있는 맞바꿈이 남아 있으면 실패)
const fixed = m => m.isLeader || m.isNew;
const repeats = (p2, p1) => p2.reduce((n, tb) => {
    for (let a = 0; a < tb.length; a++) for (let b = a + 1; b < tb.length; b++)
        if (p1.some(pt => pt.includes(tb[a]) && pt.includes(tb[b]))) n++;
    return n;
}, 0);
for (let i = 0; i < N; i++) {
    const p1 = build([], null)(today, false);
    const p2 = build([], JSON.parse(JSON.stringify(p1)))(today, true);
    const base = repeats(p2, p1), baseSpan = p2.reduce((n, tb) => n + span(tb), 0);
    for (let x = 0; x < p2.length; x++) for (let y = x + 1; y < p2.length; y++)
        for (let a = 0; a < p2[x].length; a++) for (let b = 0; b < p2[y].length; b++) {
            if (fixed(p2[x][a]) || fixed(p2[y][b])) continue; // 고정석은 못 움직임
            const alt = p2.map(tb => tb.slice());
            [alt[x][a], alt[y][b]] = [alt[y][b], alt[x][a]];
            const altSpan = alt.reduce((n, tb) => n + span(tb), 0);
            assert.ok(!(altSpan <= baseSpan && repeats(alt, p1) < base),
                `세대를 유지하면서 1부 재만남을 더 줄일 수 있음: ${p2[x][a].name} <-> ${p2[y][b].name}`);
        }
}

console.log('✅ 배치 규칙 6개 모두 통과 (각 ' + N + '회 반복)');
