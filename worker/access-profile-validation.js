function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function publicProfileData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'password' || value[key] === undefined) continue;
    const nested = value[key];
    result[key] = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? publicProfileData(nested)
      : Array.isArray(nested)
        ? nested.map((item) => item && typeof item === 'object' ? publicProfileData(item) : item)
        : nested;
  }
  return result;
}

function parseProfileJson(value) {
  try {
    return publicProfileData(JSON.parse(String(value || '')));
  } catch {
    return null;
  }
}

export function hasAccessProfileChanged(profile, existingRow) {
  if (!existingRow) return true;
  const code = String(profile.code ?? '').trim();
  const kind = String(profile.kind ?? '');
  const active = profile.active ? 1 : 0;
  if (String(existingRow.code ?? '') !== code || String(existingRow.kind ?? '') !== kind || Number(existingRow.active) !== active) return true;
  const previous = parseProfileJson(existingRow.profile_json);
  const current = publicProfileData({ ...profile, password: '' });
  return !previous || JSON.stringify(previous) !== JSON.stringify(current);
}

function issue(message, field, profileId = '') {
  return { error: message, field, profileId };
}

export function validateAccessProfiles(profiles, existingRows = []) {
  if (!Array.isArray(profiles)) return issue('A lista completa de perfis é necessária para salvar alterações.', 'profiles');
  if (profiles.length > 500) return issue('O limite é de 500 perfis de acesso.', 'profiles');

  const existing = new Map(existingRows.map((row) => [String(row.id), row]));
  const seenIds = new Set();
  const seenCodes = new Map();

  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return issue('Há um perfil com dados inválidos. Atualize a página e tente novamente.', 'profile');
    }

    const id = String(profile.id ?? '').trim();
    const profileId = id;
    if (!id || id.length > 128 || /[\u0000-\u001f]/.test(id)) {
      return issue('Não foi possível identificar um dos perfis. Atualize a página e tente novamente.', 'id', profileId);
    }
    if (seenIds.has(id)) return issue('A lista contém perfis duplicados. Atualize a página antes de salvar.', 'id', profileId);
    seenIds.add(id);

    const code = String(profile.code ?? '').trim();
    if (code.length < 4 || code.length > 64 || /[\u0000-\u001f]/.test(code)) {
      return issue('O código de acesso deve ter de 4 a 64 caracteres.', 'code', profileId);
    }
    const normalizedCode = normalize(code);
    if (seenCodes.has(normalizedCode)) return issue(`O código “${code}” já está em uso por outro perfil. Escolha um código diferente.`, 'code', profileId);
    seenCodes.set(normalizedCode, id);

    const kind = normalize(profile.kind);
    if (!['neoenergia', 'nper', 'inspetor', 'vencer'].includes(kind)) {
      return issue('Selecione Neoenergia ou Vencer como tipo de acesso.', 'kind', profileId);
    }
    if (typeof profile.active !== 'boolean') return issue('O estado do perfil está inválido. Atualize a página e tente novamente.', 'active', profileId);

    const previous = existing.get(id);
    const changed = hasAccessProfileChanged(profile, previous) || Boolean(String(profile.password ?? ''));
    if (!changed) continue;

    const responsible = String(profile.responsible ?? '').trim();
    const team = String(profile.team ?? '').trim();
    if (!responsible && !team) return issue('Informe o responsável para vincular este perfil às ordens corretas.', 'responsible', profileId);
    if (responsible.length > 180 || team.length > 180) return issue('O responsável pode ter até 180 caracteres.', 'responsible', profileId);
    if ([responsible, team].some((value) => /^cancelar\s+(?:a\s+)?ordem$/.test(normalize(value)))) {
      return issue('Uma linha “Cancelar ordem” não pode ser usada como responsável ou equipe de acesso.', 'responsible', profileId);
    }

    const operatorName = String(profile.operatorName ?? '').trim();
    const label = String(profile.label ?? '').trim();
    if ((!previous && !operatorName) || (!operatorName && !label)) return issue('Informe o nome que será registrado nos protocolos.', 'operatorName', profileId);
    if (!label || label.length > 180) return issue('O nome do perfil deve ter de 1 a 180 caracteres.', 'label', profileId);
    if (operatorName.length > 120) return issue('O nome registrado nos protocolos pode ter até 120 caracteres.', 'operatorName', profileId);

    const password = String(profile.password ?? '');
    if (!previous && !password) return issue('Informe uma senha para o novo perfil.', 'password', profileId);
    if (password && password.trim().length < 4) return issue('A senha precisa ter pelo menos 4 caracteres.', 'password', profileId);
    if (password.length > 128) return issue('A senha pode ter no máximo 128 caracteres.', 'password', profileId);

    const conflictingRow = existingRows.find((row) => String(row.id) !== id && normalize(row.code) === normalizedCode);
    if (conflictingRow) return issue(`O código “${code}” já pertence a outro perfil. Escolha um código diferente.`, 'code', profileId);
  }

  return null;
}
