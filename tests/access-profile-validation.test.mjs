import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAccessProfileChanged, validateAccessProfiles } from '../worker/access-profile-validation.js';

function profile(overrides = {}) {
  return {
    id: 'profile-test-1',
    kind: 'neoenergia',
    label: 'Neoenergia • Responsável futuro • Operador Teste',
    operatorName: 'Operador Teste',
    code: 'NEO@01',
    password: 'neo@01',
    team: '',
    responsible: 'Responsável futuro',
    active: true,
    ...overrides,
  };
}

test('permite perfil válido mesmo sem ordem atual do responsável', () => {
  assert.equal(validateAccessProfiles([profile()], []), null);
});

test('rejeita perfil sem responsável, mesmo que tenha código e senha', () => {
  const result = validateAccessProfiles([profile({ responsible: '' })], []);
  assert.equal(result.field, 'responsible');
  assert.match(result.error, /responsável/i);
});

test('rejeita linha de cancelamento como escopo de perfil', () => {
  const result = validateAccessProfiles([profile({ responsible: 'Cancelar a ordem' })], []);
  assert.equal(result.field, 'responsible');
  assert.match(result.error, /Cancelar ordem/i);
});

test('rejeita senha curta em perfil novo', () => {
  const result = validateAccessProfiles([profile({ password: 'abc' })], []);
  assert.equal(result.field, 'password');
  assert.match(result.error, /4 caracteres/);
});

test('rejeita código duplicado sem diferenciar maiúsculas/minúsculas', () => {
  const result = validateAccessProfiles([
    profile(),
    profile({ id: 'profile-test-2', code: 'neo@01', responsible: 'Outro responsável' }),
  ], []);
  assert.equal(result.field, 'code');
  assert.match(result.error, /já está em uso/i);
});

test('rejeita código que já pertence a outro perfil salvo', () => {
  const result = validateAccessProfiles([profile()], [{ id: 'profile-old', code: 'neo@01' }]);
  assert.equal(result.field, 'code');
  assert.match(result.error, /já pertence a outro perfil/i);
});

test('rejeita tipos de perfil inválidos', () => {
  const result = validateAccessProfiles([profile({ kind: 'desconhecido' })], []);
  assert.equal(result.field, 'kind');
  assert.match(result.error, /Neoenergia ou Vencer/);
});

test('não marca perfil inalterado como modificado por ordem diferente das propriedades', () => {
  const savedProfile = {
    id: 'profile-test-1',
    kind: 'neoenergia',
    label: 'Neoenergia • Responsável futuro • Operador Teste',
    operatorName: 'Operador Teste',
    code: 'NEO@01',
    password: '',
    team: '',
    responsible: 'Responsável futuro',
    active: true,
  };
  const row = {
    id: 'profile-test-1',
    code: 'NEO@01',
    kind: 'neoenergia',
    active: 1,
    profile_json: JSON.stringify(savedProfile),
  };
  const reordered = {
    active: true,
    responsible: 'Responsável futuro',
    team: '',
    code: 'NEO@01',
    operatorName: 'Operador Teste',
    label: 'Neoenergia • Responsável futuro • Operador Teste',
    kind: 'neoenergia',
    id: 'profile-test-1',
  };
  assert.equal(hasAccessProfileChanged(reordered, row), false);
  assert.equal(validateAccessProfiles([reordered], [row]), null);
});

test('marca mudança de nome como alteração', () => {
  const current = profile({ password: '' });
  const row = {
    id: current.id,
    code: current.code,
    kind: current.kind,
    active: 1,
    profile_json: JSON.stringify({ ...current, password: '' }),
  };
  assert.equal(hasAccessProfileChanged({ ...current, operatorName: 'Outro nome' }, row), true);
});
