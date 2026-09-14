#!/usr/bin/env node
// =============================================================================
// fetch.js — Puxa deals do HubSpot e gera data.json para o Painel Prospecção
// Roda via GitHub Actions (cron diário) ou local: node scripts/fetch.js
// =============================================================================

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── CONFIGURAÇÃO ───────────────────────────────────────────────────────────
// Preencha com os valores do seu HubSpot. O token vem do env (GitHub Secret).
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!HUBSPOT_TOKEN) { console.error('❌ HUBSPOT_ACCESS_TOKEN não definido'); process.exit(1); }

const API = 'https://api.hubapi.com';

// Pipeline de prospecção
const PIPELINE_ID = '24595557';  // ← ajuste pro seu pipeline

// Stage IDs (mesmos do Cortex — confirme no seu HubSpot)
const STAGES = {
  mapeamento:     '72557853',
  abordar:        '24595558',
  em_cadencia:    '24595559',
  lead_conectado: '24595562',
  qual_agendada:  '24595560',
  sql:            '24595561',   // "Qual. Realizada" no HubSpot
  sao:            '9102669',
  sdr_lost:       '24595564',
  opp_lost:       'closedlost',
};
const ALL_STAGE_IDS = Object.values(STAGES);

// Propriedades do deal a buscar
// hs_date_entered_{stageId} são auto-geradas pelo HubSpot para cada stage
const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'amount',
  'hubspot_owner_id', 'closed_lost_reason', 'closedate',
  // ── CUSTOM: ajuste os nomes abaixo pro seu CRM ──
  'porte',              // ou 'porte_da_empresa', etc.
  'setor',              // ou 'industry', etc.
  'ev_responsavel',     // owner do EV, se for prop separada
  // Stage timestamps (gerados automaticamente pelo HubSpot)
  ...ALL_STAGE_IDS.map(id => `hs_date_entered_${id}`),
];

// Filtro de quais deals puxar (ajuste conforme necessário)
// Ex: todos os deals do pipeline de prospecção criados no mês corrente
function buildSearchFilter(monthStart, monthEnd) {
  return {
    filterGroups: [{
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_ID },
        { propertyName: 'createdate', operator: 'GTE', value: new Date(monthStart).getTime() },
        { propertyName: 'createdate', operator: 'LTE', value: new Date(monthEnd + 'T23:59:59Z').getTime() },
      ]
    }],
    properties: DEAL_PROPS,
    limit: 100,
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
  };
}

// ─── HUBSPOT API ────────────────────────────────────────────────────────────
const headers = {
  'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

async function hubspotGet(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`HubSpot GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function hubspotPost(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HubSpot POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Busca todos os deals com paginação
async function fetchAllDeals(searchBody) {
  const deals = [];
  let after = 0;
  while (true) {
    const body = { ...searchBody, after };
    const data = await hubspotPost('/crm/v3/objects/deals/search', body);
    deals.push(...(data.results || []));
    console.log(`  … ${deals.length} deals carregados`);
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return deals;
}

// Busca owners para mapear IDs → nomes
async function fetchOwners() {
  const map = {};
  let after;
  while (true) {
    const url = after
      ? `/crm/v3/owners?limit=100&after=${after}`
      : '/crm/v3/owners?limit=100';
    const data = await hubspotGet(url);
    for (const o of data.results || []) {
      map[o.id] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email;
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return map;
}

// ─── BUSINESS DAYS ──────────────────────────────────────────────────────────
function businessDaysElapsed(monthStart, today) {
  let count = 0;
  const d = new Date(monthStart);
  const end = new Date(today);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ─── STAGE NAME LOOKUP ──────────────────────────────────────────────────────
const STAGE_NAMES = {};
for (const [key, id] of Object.entries(STAGES)) {
  STAGE_NAMES[id] = key;
}

function lostStageName(stageId) {
  const key = STAGE_NAMES[stageId];
  const names = {
    mapeamento: 'Mapeamento', abordar: 'Abordar', em_cadencia: 'Em cadência',
    lead_conectado: 'Lead conectado', qual_agendada: 'Qual. agendada',
    sql: 'SQL', sao: 'SAO', sdr_lost: 'Perdido SDR', opp_lost: 'Perdido OPP',
  };
  return names[key] || stageId;
}

// ─── TRANSFORM DEAL ─────────────────────────────────────────────────────────
function transformDeal(raw, owners) {
  const p = raw.properties || {};

  // Build stages map from hs_date_entered_* properties
  const stages = {};
  for (const id of ALL_STAGE_IDS) {
    const val = p[`hs_date_entered_${id}`];
    if (val) stages[id] = val;
  }

  const currentStage = p.dealstage;
  const isLost = currentStage === STAGES.sdr_lost || currentStage === STAGES.opp_lost;

  // Determine which stage the deal was lost from
  let lostStage = null;
  if (isLost) {
    // Find the last active stage before lost (most recent timestamp)
    const activeStages = Object.entries(stages)
      .filter(([id]) => id !== STAGES.sdr_lost && id !== STAGES.opp_lost)
      .sort((a, b) => new Date(b[1]) - new Date(a[1]));
    if (activeStages.length > 0) lostStage = lostStageName(activeStages[0][0]);
  }

  const ownerId = p.hubspot_owner_id;
  const ownerName = owners[ownerId] || `Owner ${ownerId || 'N/A'}`;

  return {
    id: raw.id,
    company: p.dealname || '— sem nome',
    porte: p.porte || null,
    setor: p.setor || '— sem categoria',
    cn: ownerName,
    ev: p.ev_responsavel ? owners[p.ev_responsavel] || p.ev_responsavel : ownerName,
    stages,
    amount: Number(p.amount) || 0,
    isLost,
    lostStage,
    lostReason: isLost ? (p.closed_lost_reason || null) : null,
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Painel Prospecção — sync HubSpot\n');

  // Load targets
  const targetsFile = JSON.parse(readFileSync(resolve(ROOT, 'targets.json'), 'utf-8'));
  const { month, monthLabel, businessDays, targets } = targetsFile;
  const monthStart = `${month}-01`;
  const lastDay = new Date(Number(month.split('-')[0]), Number(month.split('-')[1]), 0).getDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

  console.log(`📅 Mês: ${monthLabel} (${monthStart} → ${monthEnd})`);
  console.log(`🎯 Metas: ${targets.map(t => `${t.name}=${t.target}`).join(', ')}\n`);

  // Fetch owners
  console.log('👥 Buscando owners…');
  const owners = await fetchOwners();
  console.log(`   ${Object.keys(owners).length} owners encontrados\n`);

  // Fetch deals
  console.log('📊 Buscando deals…');
  const searchBody = buildSearchFilter(monthStart, monthEnd);
  const rawDeals = await fetchAllDeals(searchBody);
  console.log(`   ${rawDeals.length} deals no período\n`);

  // Transform
  const deals = rawDeals.map(d => transformDeal(d, owners));

  // Compute meta
  const today = new Date().toISOString().slice(0, 10);
  const bizElapsed = businessDaysElapsed(monthStart, today > monthEnd ? monthEnd : today);

  // Porte counts
  const porteCounts = { all: deals.length };
  const porteSet = new Set();
  deals.forEach(d => { if (d.porte) { porteSet.add(d.porte); porteCounts[d.porte] = (porteCounts[d.porte] || 0) + 1; } });

  // Filters
  const setores = [...new Set(deals.map(d => d.setor).filter(Boolean))].sort();
  const cns = [...new Set(deals.map(d => d.cn).filter(Boolean))].sort();
  const evs = [...new Set(deals.map(d => d.ev).filter(Boolean))].sort();

  // Build data.json
  const data = {
    meta: {
      updatedAt: new Date().toISOString(),
      monthLabel,
      monthStart,
      monthEnd,
      businessDays,
      businessDaysElapsed: bizElapsed,
      companiesTotal: new Set(deals.map(d => d.company)).size,
      availablePortes: [...porteSet].sort(),
      porteCounts,
    },
    targets,
    deals,
    filters: { setores, cns, evs },
    debug: {
      totalDeals: deals.length,
      dealsWithoutPorte: deals.filter(d => !d.porte).length,
    },
  };

  // Write
  const outPath = resolve(ROOT, 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✅ data.json gerado: ${deals.length} deals → ${outPath}`);
}

main().catch(err => { console.error('💥 Erro:', err.message); process.exit(1); });
