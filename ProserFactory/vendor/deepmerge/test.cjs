const assert = require('node:assert/strict');
const { test } = require('node:test');
const patched = require('./index.cjs');
const original = require('./upstream.cjs');

for (const clone of [true, false]) {
  test(`target prototype poisoning is reproduced upstream and prevented (clone=${clone})`, () => {
    const target = JSON.parse('{"__proto__":{"poisoned":true},"normal":1}');
    const vulnerable = original(target, {}, {clone});
    assert.equal(vulnerable.poisoned, true);
    const result = patched(target, {}, {clone});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.poisoned, undefined);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.normal, 1);
    assert.equal({}.poisoned, undefined);
  });
  test(`null-prototype source cannot invoke destination prototype setter (clone=${clone})`, () => {
    const target = Object.create(null);
    const source = JSON.parse('{"__proto__":{"poisoned":true}}');
    assert.equal(original(target, source, {clone}).poisoned, true);
    const result = patched(target, source, {clone});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.poisoned, undefined);
    assert.equal(Object.hasOwn(result, '__proto__'), true);
  });
}

test('nested object/array cloning, symbols, dates and all retain upstream behavior', () => {
  const symbol=Symbol('fixture');
  const left={nested:{one:1},items:[{two:2}],[symbol]:{three:3}};
  const right={nested:{four:4},items:[{five:5}],date:new Date(0)};
  const result=patched(left,right);
  assert.deepEqual(result,original(left,right));
  assert.notEqual(result.nested,left.nested);
  assert.notEqual(result.items[0],left.items[0]);
  assert.notEqual(result[symbol],left[symbol]);
  assert.equal(result.date,right.date);
  assert.deepEqual(patched.all([left,right]),result);
  assert.throws(()=>patched.all({}),/first argument/);
});

test('custom merge and array hooks retain behavior; inherited source keys remain ignored', () => {
  const options={arrayMerge:(_target,source)=>source,customMerge:key=>key==='value'?((a,b)=>a+b):undefined};
  const left={value:{one:1},items:[1]},right={value:{two:2},items:[2]};
  assert.deepEqual(patched(left,right,options),original(left,right,options));
  const source=Object.create({inherited:true});source.own=1;
  assert.deepEqual(patched({},source),{own:1});
});

test('the installed Jest dependency resolves to the maintained implementation', () => {
  const jestRequire = require('node:module').createRequire(require.resolve('jest-config'));
  assert.equal(jestRequire('deepmerge'), patched);
});
