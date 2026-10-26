const SESSION_COOKIE = 'neo_session';
const SESSION_SECONDS = 60 * 60 * 12;
const PASSWORD_HASH_ITERATIONS = 100000;
const LEGACY_PASSWORD_HASH_ITERATIONS = 120000;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function canonicalCompany(value) {
  const company = normalize(value);
  return company === 'nper' ? 'neoenergia' : company;
}

function canonicalProfileKind(value) {
  return normalize(value) === 'vencer' ? 'vencer' : 'neoenergia';
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64(value) {
  const standardBase64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = standardBase64 + '='.repeat((4 - standardBase64.length % 4) % 4);
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function parsePasswordSalt(value) {
  const stored = String(value);
  const match = stored.match(/^pbkdf2:(\d+):(.+)$/);
  if (match) return { iterations: Number(match[1]), encodedSalt: match[2] };
  return { iterations: LEGACY_PASSWORD_HASH_ITERATIONS, encodedSalt: stored };
}

async function hashPassword(password, salt) {
  const parsed = parsePasswordSalt(salt);
  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1 || parsed.iterations > PASSWORD_HASH_ITERATIONS) {
    throw new Error(`PBKDF2 iteration count ${parsed.iterations} is unsupported; create a new access profile.`);
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: decodeBase64(parsed.encodedSalt), iterations: parsed.iterations, hash: 'SHA-256' }, key, 256);
  return base64url(new Uint8Array(bits));
}

function equalSecret(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function cookieValue(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  for (const part of cookies.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function publicProfile(raw) {
  try {
    const profile = JSON.parse(raw);
    delete profile.password;
    return profile;
  } catch {
    return null;
  }
}

function getScope(profile) {
  return {
    id: profile.id,
    kind: canonicalProfileKind(profile.kind),
    label: profile.label,
    team: String(profile.team || ''),
    responsible: profile.responsible || '',
    operatorName: profile.operatorName || profile.responsible || profile.label,
  };
}

async function readSession(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    'SELECT profile_id, is_admin, expires_at FROM sessions WHERE token_hash = ?1 AND expires_at > ?2',
  ).bind(tokenHash, Date.now()).first();
  if (!row) return null;
  if (row.is_admin) return { isAdmin: true, id: 'supervisor', kind: 'admin', label: 'Supervisor', team: '', responsible: '', operatorName: 'Supervisor' };
  const profileRow = await env.DB.prepare(
    'SELECT profile_json FROM access_profiles WHERE id = ?1 AND active = 1',
  ).bind(row.profile_id).first();
  const profile = profileRow && publicProfile(profileRow.profile_json);
  return profile ? { isAdmin: false, ...getScope(profile) } : null;
}

function allowedOrder(session, order) {
  if (session.isAdmin) return true;
  const hasTeamScope = Boolean(normalize(session.team));
  const hasResponsibleScope = Boolean(normalize(session.responsible));
  if (!hasTeamScope && !hasResponsibleScope) return false;
  const company = canonicalCompany(order.empresa);
  const profileKind = canonicalProfileKind(session.kind);
  const matchesCompany = profileKind === 'vencer' ? company === 'vencer' : company === 'neoenergia';
  const matchesTeam = !hasTeamScope || normalize(order.equipe) === normalize(session.team);
  const matchesResponsible = !hasResponsibleScope || normalize(order.responsavel) === normalize(session.responsible);
  return matchesCompany && matchesTeam && matchesResponsible;
}

async function readOrders(env, session) {
  let statement;
  if (session.isAdmin) statement = env.DB.prepare('SELECT payload_json FROM work_orders ORDER BY id');
  else if (normalize(session.team)) statement = env.DB.prepare('SELECT payload_json FROM work_orders WHERE team = ?1 COLLATE NOCASE ORDER BY id').bind(session.team);
  else if (normalize(session.responsible)) statement = env.DB.prepare('SELECT payload_json FROM work_orders WHERE responsible = ?1 COLLATE NOCASE ORDER BY id').bind(session.responsible);
  else return [];
  const result = await statement.all();
  const orders = result.results.map((row) => JSON.parse(row.payload_json));
  return session.isAdmin ? orders : orders.filter((order) => allowedOrder(session, order));
}

async function readSyncCursor(env) {
  const row = await env.DB.prepare('SELECT catalog_revision, change_revision FROM sync_metadata WHERE id = 1').first();
  return {
    catalogRevision: Number(row?.catalog_revision || 0),
    changeRevision: Number(row?.change_revision || 0),
  };
}

async function readState(env, session) {
  const sync = await readSyncCursor(env);
  const orders = await readOrders(env, session);
  const importsRows = await env.DB.prepare('SELECT payload_json FROM imports ORDER BY imported_at DESC').all();
  const imports = session.isAdmin ? importsRows.results.map((row) => JSON.parse(row.payload_json)) : [];
  let profiles = [];
  if (session.isAdmin) {
    const profileRows = await env.DB.prepare('SELECT profile_json FROM access_profiles ORDER BY updated_at DESC').all();
    profiles = profileRows.results.map((row) => publicProfile(row.profile_json)).filter(Boolean);
  }
  return { orders, profiles, imports, notifications: [], sync, full: true };
}

async function readExecutionNotifications(env, session, afterRevision, throughRevision) {
  const rows = await env.DB.prepare(`SELECT payload_json FROM work_orders
    WHERE change_revision > ?1 AND change_revision <= ?2 AND status IN ('executada', 'impedimento')
    ORDER BY change_revision, id`).bind(afterRevision, throughRevision).all();

  return rows.results.map((row) => JSON.parse(row.payload_json))
    .filter((order) => order.protocolo && order.dataRegistro && (
      session.isAdmin || canonicalCompany(order.empresa) === canonicalProfileKind(session.kind)
    ))
    .map((order) => ({
      id: String(order.protocolo),
      orderNumber: String(order.numConsequencia || ''),
      team: String(order.equipe || ''),
      service: String(order.servico || ''),
      registeredBy: String(order.registradoPor || ''),
      status: order.status,
      ...(Number.isFinite(Number(order.qtdExecutada)) ? { quantity: Number(order.qtdExecutada) } : {}),
      occurredAt: String(order.dataRegistro),
      protocol: String(order.protocolo),
    }));
}

async function readIncrementalState(env, session, url) {
  const cursor = await readSyncCursor(env);
  const catalogParam = url.searchParams.get('catalogRevision');
  const changeParam = url.searchParams.get('changeRevision');
  const catalogRevision = Number(catalogParam);
  const changeRevision = Number(changeParam);
  const hasCursor = catalogParam !== null && changeParam !== null &&
    Number.isSafeInteger(catalogRevision) && Number.isSafeInteger(changeRevision) &&
    catalogRevision >= 0 && changeRevision >= 0;

  if (!hasCursor || catalogRevision !== cursor.catalogRevision) {
    return readState(env, session);
  }
  if (changeRevision >= cursor.changeRevision) {
    return { orders: [], profiles: [], imports: [], notifications: [], sync: cursor, full: false, unchanged: true };
  }

  const notifications = await readExecutionNotifications(env, session, changeRevision, cursor.changeRevision);

  let result;
  if (session.isAdmin) {
    result = await env.DB.prepare('SELECT payload_json FROM work_orders WHERE change_revision > ?1 ORDER BY change_revision, id').bind(changeRevision).all();
  } else if (normalize(session.team)) {
    result = await env.DB.prepare('SELECT payload_json FROM work_orders WHERE change_revision > ?1 AND team = ?2 COLLATE NOCASE ORDER BY change_revision, id').bind(changeRevision, session.team).all();
  } else if (normalize(session.responsible)) {
    result = await env.DB.prepare('SELECT payload_json FROM work_orders WHERE change_revision > ?1 AND responsible = ?2 COLLATE NOCASE ORDER BY change_revision, id').bind(changeRevision, session.responsible).all();
  } else {
    return { orders: [], profiles: [], imports: [], notifications, sync: cursor, full: false, unchanged: notifications.length === 0 };
  }
  const orders = result.results.map((row) => JSON.parse(row.payload_json)).filter((order) => allowedOrder(session, order));
  return { orders, profiles: [], imports: [], notifications, sync: cursor, full: false, unchanged: orders.length === 0 && notifications.length === 0 };
}

async function requireSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return { error: json({ error: 'Sessão encerrada. Entre novamente.' }, 401) };
  return { session };
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

async function recordFailedLogin(env, key) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT failures, window_started, locked_until FROM login_attempts WHERE attempt_key = ?1').bind(key).first();
  const sameWindow = row && now - row.window_started < 15 * 60 * 1000;
  const failures = sameWindow ? row.failures + 1 : 1;
  const lockedUntil = failures >= 8 ? now + 15 * 60 * 1000 : 0;
  await env.DB.prepare(`INSERT INTO login_attempts(attempt_key, failures, window_started, locked_until)
    VALUES (?1, ?2, ?3, ?4) ON CONFLICT(attempt_key) DO UPDATE SET
    failures = excluded.failures, window_started = excluded.window_started, locked_until = excluded.locked_until`)
    .bind(key, failures, sameWindow ? row.window_started : now, lockedUntil).run();
}

async function clearFailedLogin(env, key) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key = ?1').bind(key).run();
}

async function createSession(request, env, profileId, isAdmin) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  await env.DB.prepare('INSERT INTO sessions(token_hash, profile_id, is_admin, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256(token), profileId, isAdmin ? 1 : 0, expiresAt, new Date().toISOString()).run();
  return {
    'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
  };
}

function makeProtocol() {
  const date = new Date();
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  return `NEO-${date.getFullYear()}-${date.getTime().toString(36).toUpperCase()}-${suffix}`;
}

async function login(request, env) {
  const body = await request.json();
  const kind = String(body.kind || '');
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  const remoteIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const attemptKey = await sha256(`${remoteIp}:${kind === 'admin' ? 'admin' : 'team'}:${normalize(code)}`);
  const attempt = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE attempt_key = ?1').bind(attemptKey).first();
  if (attempt?.locked_until > Date.now()) return json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }, 429);

  if (kind === 'admin') {
    const valid = Boolean(env.SUPERVISOR_CODE) && normalize(code) === normalize(env.SUPERVISOR_CODE) &&
      Boolean(env.SUPERVISOR_PASSWORD) && equalSecret(password, env.SUPERVISOR_PASSWORD);
    if (!valid) {
      await recordFailedLogin(env, attemptKey);
      return json({ error: 'Código ou senha do supervisor inválidos.' }, 401);
    }
    await clearFailedLogin(env, attemptKey);
    const cookie = await createSession(request, env, 'supervisor', true);
    const session = { isAdmin: true, kind: 'admin', label: 'Supervisor', operatorName: 'Supervisor', team: '', responsible: '' };
    return json({ session, state: await readState(env, session) }, 200, cookie);
  }

  const profileRow = await env.DB.prepare(
    'SELECT id, kind, password_salt, password_hash, profile_json FROM access_profiles WHERE code = ?1 COLLATE NOCASE AND active = 1',
  ).bind(code).first();
  let profile = profileRow && publicProfile(profileRow.profile_json);
  const selectedKind = kind ? canonicalProfileKind(kind) : '';
  const matchesKind = !selectedKind || selectedKind === canonicalProfileKind(profile?.kind || profileRow?.kind || '');
  let passwordHashMatches = false;
  if (profileRow && profile && matchesKind) {
    try {
      passwordHashMatches = await equalSecret(await hashPassword(password, profileRow.password_salt), profileRow.password_hash);
    } catch (error) {
      if (error instanceof Error && error.message.includes('create a new access profile')) {
        return json({ error: 'Este perfil usa um hash de senha antigo e incompatível. O supervisor precisa criar um novo acesso.' }, 409);
      }
      throw error;
    }
  }
  const valid = profileRow && profile && matchesKind && passwordHashMatches;
  if (!valid) {
    await recordFailedLogin(env, attemptKey);
    return json({ error: 'Não foi possível entrar. Confira se selecionou Neoenergia ou Vencer corretamente, além do código e da senha.' }, 401);
  }
  await clearFailedLogin(env, attemptKey);
  const cookie = await createSession(request, env, profileRow.id, false);
  const session = { isAdmin: false, ...getScope(profile) };
  return json({ session, state: await readState(env, session) }, 200, cookie);
}

async function saveAdminState(request, env) {
  const body = await request.json();
  const orders = Array.isArray(body.orders) ? body.orders : [];
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  const imports = Array.isArray(body.imports) ? body.imports : [];
  const changedParts = Array.isArray(body.changedParts)
    ? new Set(body.changedParts.filter((part) => ['orders', 'profiles', 'imports'].includes(part)))
    : new Set(['orders', 'profiles', 'imports']);
  if (orders.length > 12000 || profiles.length > 500 || imports.length > 5000) return json({ error: 'O arquivo excede o limite desta versão.' }, 413);

  if (changedParts.has('orders')) {
    await env.DB.prepare('DELETE FROM work_orders').run();
    for (let start = 0; start < orders.length; start += 80) {
      const chunk = orders.slice(start, start + 80);
      const statements = chunk.map((order) => env.DB.prepare(
        'INSERT INTO work_orders(id, team, responsible, status, payload_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ).bind(String(order.id), String(order.equipe || ''), String(order.responsavel || ''), String(order.status || 'pendente'), JSON.stringify(order), new Date().toISOString()));
      if (statements.length) await env.DB.batch(statements);
    }
  }

  if (changedParts.has('profiles')) {
    const existingRows = await env.DB.prepare('SELECT id, password_salt, password_hash FROM access_profiles').all();
    const existing = new Map(existingRows.results.map((row) => [row.id, row]));
    for (const profile of profiles) {
      const id = String(profile.id || crypto.randomUUID());
      const code = String(profile.code || '').trim();
      if (!code) continue;
      const previous = existing.get(id);
      const suppliedPassword = String(profile.password || '');
      let salt = previous?.password_salt;
      let passwordHash = previous?.password_hash;
      if (suppliedPassword) {
        salt = `pbkdf2:${PASSWORD_HASH_ITERATIONS}:${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
        passwordHash = await hashPassword(suppliedPassword, salt);
      }
      if (!salt || !passwordHash) continue;
      const publicData = { ...profile, id, password: '' };
      await env.DB.prepare(`INSERT INTO access_profiles(id, code, kind, password_salt, password_hash, profile_json, active, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET code=excluded.code, kind=excluded.kind,
        password_salt=excluded.password_salt, password_hash=excluded.password_hash,
        profile_json=excluded.profile_json, active=excluded.active, updated_at=excluded.updated_at`)
        .bind(id, code, String(profile.kind || ''), salt, passwordHash, JSON.stringify(publicData), profile.active ? 1 : 0, new Date().toISOString()).run();
    }

    const storedProfileIds = new Set(profiles.map((profile) => String(profile.id)));
    for (const row of existingRows.results) {
      if (!storedProfileIds.has(row.id)) await env.DB.prepare('DELETE FROM access_profiles WHERE id = ?1').bind(row.id).run();
    }
  }

  if (changedParts.has('imports')) {
    await env.DB.prepare('DELETE FROM imports').run();
    for (let start = 0; start < imports.length; start += 80) {
      const statements = imports.slice(start, start + 80).map((item) => env.DB.prepare(
        'INSERT INTO imports(id, imported_at, payload_json) VALUES (?1, ?2, ?3)',
      ).bind(String(item.id), String(item.importedAt || ''), JSON.stringify(item)));
      if (statements.length) await env.DB.batch(statements);
    }
  }
  if (changedParts.has('orders')) {
    await env.DB.prepare('UPDATE sync_metadata SET catalog_revision = catalog_revision + 1, change_revision = change_revision + 1 WHERE id = 1').run();
  } else if (changedParts.size) {
    await env.DB.prepare('UPDATE sync_metadata SET change_revision = change_revision + 1 WHERE id = 1').run();
  }
  return json({ saved: true });
}

async function addSupplementalOrders(request, env) {
  const body = await request.json();
  const incoming = Array.isArray(body.orders) ? body.orders : [];
  if (incoming.length === 0) return json({ error: 'A planilha não contém ordens para adicionar.' }, 400);
  if (incoming.length > 3000) return json({ error: 'A planilha complementar deve conter no máximo 3.000 ordens por envio.' }, 413);

  const text = (value, limit) => String(value ?? '').trim().slice(0, limit);
  const fileName = text(body.fileName, 240) || 'Planilha complementar';
  const sheetName = text(body.sheetName, 120);
  const sourceColumns = Array.isArray(body.sourceColumns)
    ? body.sourceColumns.slice(0, 120).map((column) => text(column, 120)).filter(Boolean)
    : [];
  const rows = [];
  let excludedCount = 0;
  for (const raw of incoming) {
    const numConsequencia = text(raw.numConsequencia, 100);
    const companyInput = normalize(raw.empresa);
    const empresa = companyInput === 'vencer' ? 'Vencer' : companyInput === 'neoenergia' || companyInput === 'nper' ? 'Neoenergia' : '';
    const equipe = text(raw.equipe, 200);
    const responsavel = text(raw.responsavel, 200);
    const servico = text(raw.servico, 300);
    const qtdAjustada = text(raw.qtdAjustada, 80);
    const quantityMatch = qtdAjustada.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    if (!numConsequencia || !empresa || !equipe || !responsavel || !servico || !quantityMatch || Number(quantityMatch[0]) <= 0) {
      excludedCount += 1;
      continue;
    }
    const rawOriginal = raw.original && typeof raw.original === 'object' ? Object.entries(raw.original).slice(0, 120) : [];
    const original = Object.fromEntries(rawOriginal.map(([key, value]) => [text(key, 120), text(value, 500)]).filter(([key]) => key));
    rows.push({
      id: `supplement-${crypto.randomUUID()}`,
      alimentador: text(raw.alimentador, 200),
      barramento: text(raw.barramento, 200),
      qtdAjustada,
      numConsequencia,
      empresa,
      equipe,
      servico,
      avanco: text(raw.avanco, 100),
      responsavel,
      endereco: text(raw.endereco, 500),
      status: 'pendente',
      original,
      sourceColumns,
      sourceSheet: sheetName,
      sourceFile: fileName,
      sourceKind: empresa === 'Vencer' ? 'vencer' : 'controle',
    });
  }
  if (rows.length === 0) return json({ error: 'Não encontrei ordens completas. Cada linha precisa ter número, empresa, equipe, responsável, serviço e quantidade ajustada maior que zero.' }, 400);

  const existingRows = await env.DB.prepare('SELECT payload_json FROM work_orders').all();
  const orderKey = (order) => [normalize(order.numConsequencia), canonicalCompany(order.empresa), normalize(order.responsavel)].join('|');
  const seen = new Set(existingRows.results.map((row) => orderKey(JSON.parse(row.payload_json))));
  const additions = [];
  let duplicateCount = 0;
  for (const order of rows) {
    const key = orderKey(order);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    additions.push(order);
  }

  const now = new Date().toISOString();
  for (let start = 0; start < additions.length; start += 79) {
    const chunk = additions.slice(start, start + 79);
    const statements = [env.DB.prepare('UPDATE sync_metadata SET change_revision = change_revision + 1 WHERE id = 1')];
    for (const order of chunk) {
      statements.push(env.DB.prepare(`INSERT INTO work_orders(id, team, responsible, status, payload_json, updated_at, change_revision)
        SELECT ?1, ?2, ?3, 'pendente', ?4, ?5, change_revision FROM sync_metadata WHERE id = 1`)
        .bind(order.id, order.equipe, order.responsavel, JSON.stringify(order), now));
    }
    await env.DB.batch(statements);
  }

  const importRecord = {
    id: `supplement-import-${crypto.randomUUID()}`,
    fileName,
    source: 'Ordens complementares',
    team: 'Carteira geral',
    importedAt: now,
    orderCount: additions.length,
    duplicateCount,
    excludedCount,
    sheetName,
  };
  await env.DB.prepare('INSERT INTO imports(id, imported_at, payload_json) VALUES (?1, ?2, ?3)')
    .bind(importRecord.id, now, JSON.stringify(importRecord)).run();
  return json({ orders: additions, addedCount: additions.length, duplicateCount, excludedCount, importRecord }, 201);
}

async function updateExecution(request, env, session) {
  if (session.isAdmin) return json({ error: 'Use a tela de administração para alterar as ordens.' }, 403);
  const body = await request.json();
  const orderId = String(body.orderId || '');
  const row = await env.DB.prepare('SELECT payload_json FROM work_orders WHERE id = ?1').bind(orderId).first();
  if (!row) return json({ error: 'Ordem não encontrada.' }, 404);
  const order = JSON.parse(row.payload_json);
  if (!allowedOrder(session, order)) return json({ error: 'Esta ordem não está vinculada ao seu acesso.' }, 403);
  if (order.status !== 'pendente') return json({ error: 'Esta ordem já foi atualizada por outra equipe. Atualize a lista para conferir.' }, 409);

  const status = body.status === 'impedimento' ? 'impedimento' : 'executada';
  const quantity = status === 'executada' ? Number(body.qtdExecutada) : null;
  if (status === 'executada' && (!Number.isFinite(quantity) || quantity < 0)) return json({ error: 'Informe uma quantidade válida.' }, 400);
  const observation = String(body.observacao || '').trim();
  const reason = status === 'impedimento' ? String(body.motivoImpedimento || '').trim() : '';
  if (status === 'impedimento' && (!reason || !observation)) return json({ error: 'Informe o motivo e a observação do impedimento.' }, 400);
  const planned = Number(String(order.qtdAjustada || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0] || 0);
  if (status === 'executada' && quantity < planned && !observation) return json({ error: 'Explique por que a quantidade executada ficou abaixo da ajustada.' }, 400);

  const protocol = makeProtocol();
  const now = new Date().toISOString();
  const photoData = status === 'impedimento' ? String(body.foto || '') : '';
  let photoUrl;
  let photoContentType = '';
  let photoBase64 = '';
  if (photoData) {
    const match = photoData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[2].length > 1_700_000) return json({ error: 'A imagem não está em um formato válido ou excede 1,2 MB.' }, 413);
    photoContentType = match[1];
    photoBase64 = match[2];
    photoUrl = `/api/photos/${encodeURIComponent(protocol)}`;
  }

  const updated = {
    ...order,
    status,
    qtdExecutada: status === 'executada' ? quantity : undefined,
    observacao: observation,
    motivoImpedimento: reason || undefined,
    foto: photoUrl,
    protocolo: protocol,
    registradoPor: session.operatorName,
    dataRegistro: now,
  };
  const statements = [
    env.DB.prepare(`UPDATE sync_metadata SET change_revision = change_revision + 1
      WHERE id = 1 AND EXISTS (SELECT 1 FROM work_orders WHERE id = ?1 AND status = 'pendente')`).bind(orderId),
    env.DB.prepare(`UPDATE work_orders SET status = ?1, payload_json = ?2, updated_at = ?3,
      change_revision = (SELECT change_revision FROM sync_metadata WHERE id = 1)
      WHERE id = ?4 AND status = 'pendente'`).bind(status, JSON.stringify(updated), now, orderId),
  ];

  if (photoData) {
    statements.push(env.DB.prepare(`INSERT INTO photos(protocol, content_type, data_base64, team, responsible, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM work_orders WHERE id = ?7 AND status = ?8 AND json_extract(payload_json, '$.protocolo') = ?1)`)
      .bind(protocol, photoContentType, photoBase64, order.equipe || '', order.responsavel || '', now, orderId, status));
  }
  statements.push(env.DB.prepare(`INSERT INTO execution_records(id, protocol, order_id, team, responsible, registered_by, status, payload_json, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    WHERE EXISTS (SELECT 1 FROM work_orders WHERE id = ?3 AND status = ?7 AND json_extract(payload_json, '$.protocolo') = ?2)`)
    .bind(crypto.randomUUID(), protocol, orderId, order.equipe || '', order.responsavel || '', session.operatorName, status, JSON.stringify(updated), now));

  const result = await env.DB.batch(statements);
  if (!result[1]?.meta?.changes) return json({ error: 'Outra equipe acabou de atualizar esta ordem. Atualize a lista.' }, 409);
  return json({ order: updated });
}

async function photoResponse(request, env, session, protocol) {
  const photo = await env.DB.prepare('SELECT content_type, data_base64, team, responsible FROM photos WHERE protocol = ?1').bind(protocol).first();
  if (!photo) return new Response('Imagem não encontrada.', { status: 404 });
  if (!session.isAdmin) {
    const record = await env.DB.prepare('SELECT payload_json FROM execution_records WHERE protocol = ?1').bind(protocol).first();
    const order = record && JSON.parse(record.payload_json);
    if (!order || !allowedOrder(session, order)) return new Response('Acesso negado.', { status: 403 });
  }
  const data = decodeBase64(photo.data_base64);
  return new Response(data, { headers: { 'content-type': photo.content_type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
  if (request.method === 'POST' && !sameOrigin(request, url)) return json({ error: 'Origem inválida.' }, 403);
  if (path === '/api/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/session' && request.method === 'GET') {
    const session = await readSession(request, env);
    return session ? json({ session, state: await readState(env, session) }) : json({ error: 'Sem sessão.' }, 401);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  const { session } = auth;
  if (path === '/api/state' && request.method === 'GET') return json(await readIncrementalState(env, session, url));
  if (path === '/api/admin/state' && request.method === 'POST') {
    if (!session.isAdmin) return json({ error: 'Apenas o supervisor pode alterar a carteira.' }, 403);
    try {
      return await saveAdminState(request, env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('Admin state save failed:', error);
      return json({ error: `Falha ao salvar no servidor: ${detail.slice(0, 240)}` }, 500);
    }
  }
  if (path === '/api/admin/orders/import' && request.method === 'POST') {
    if (!session.isAdmin) return json({ error: 'Apenas o supervisor pode adicionar ordens à carteira.' }, 403);
    try {
      return await addSupplementalOrders(request, env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('Supplemental order import failed:', error);
      return json({ error: `Falha ao importar ordens complementares: ${detail.slice(0, 240)}` }, 500);
    }
  }
  if (path === '/api/executions' && request.method === 'POST') return updateExecution(request, env, session);
  if (path.startsWith('/api/photos/') && request.method === 'GET') {
    const protocol = decodeURIComponent(path.slice('/api/photos/'.length));
    return photoResponse(request, env, session, protocol);
  }
  return json({ error: 'Rota não encontrada.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Método não permitido.', { status: 405, headers: { allow: 'GET, POST, OPTIONS' } });
      }
      return await route(request, env);
    } catch (error) {
      const rayId = request.headers.get('cf-ray') || crypto.randomUUID();
      const detail = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack || '' }
        : { name: typeof error, message: String(error) };
      console.error(JSON.stringify({
        event: 'worker_request_failed',
        method: request.method,
        path: new URL(request.url).pathname,
        rayId,
        error: detail,
      }));
      return json({ error: `Falha temporária no servidor. Referência: ${rayId}.` }, 500, { 'x-error-reference': rayId });
    }
  },
};
