#!/usr/bin/env node
// =============================================================================
// fetch.js v2 — Puxa TODOS os deals de Prospecção/Motor sinais do HubSpot
// Sem filtro de mês (frontend filtra client-side)
// =============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!HUBSPOT_TOKEN) { console.error('❌ HUBSPOT_ACCESS_TOKEN não definido'); process.exit(1); }

const API = 'https://api.hubapi.com';

const PIPELINE_ID = '8582978';
const PIPELINE_ID_OPP = 'default';

const STAGES_SDR = [
  { id: '72557853',  name: 'Mapeamento' },
  { id: '24595558',  name: 'Abordar' },
  { id: '24595559',  name: 'Em cadência' },
  { id: '24595562',  name: 'Lead Conectado' },
  { id: '24595560',  name: 'Qual. Agendada' },
  { id: '24595561',  name: 'Qual. Realizada' },
  { id: '9102669',   name: 'SAO' },
];
const STAGES_OPP = [
  { id: '9102669',               name: 'SAO' },
  { id: 'presentationscheduled', name: 'Elab. Proposta' },
  { id: '11505970',              name: 'Proposta Enviada' },
  { id: 'decisionmakerboughtin', name: 'Em negociação' },
  { id: '26183057',              name: 'Proposta Aceita' },
];
const STAGE_SDR_LOST = '24595564';
const STAGE_OPP_LOST = 'closedlost';
const ALL_STAGE_IDS = [...new Set([
  ...STAGES_SDR.map(s => s.id), ...STAGES_OPP.map(s => s.id),
  STAGE_SDR_LOST, STAGE_OPP_LOST, 'closedwon',
])];

const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'amount', 'createdate',
  'hubspot_owner_id', 'closed_lost_reason',
  'porte', 'setor', 'origem', 'origem_micro_', 'ev_responsavel',
  ...ALL_STAGE_IDS.map(id => `hs_v2_date_entered_${id}`),
];

// Filtro: origem=Prospecção + origem_micro_=Motor sinais (SEM filtro de mês)
function buildSearchBody() {
  return {
    filterGroups: [
      {
        filters: [
          { propertyName: 'pipeline',      operator: 'EQ', value: PIPELINE_ID },
          { propertyName: 'origem',        operator: 'EQ', value: 'Prospecção' },
          { propertyName: 'origem_micro_', operator: 'EQ', value: 'Motor sinais' },
        ]
      },
      {
        filters: [
          { propertyName: 'pipeline',      operator: 'EQ', value: PIPELINE_ID_OPP },
          { propertyName: 'origem',        operator: 'EQ', value: 'Prospecção' },
          { propertyName: 'origem_micro_', operator: 'EQ', value: 'Motor sinais' },
        ]
      },
    ],
    properties: DEAL_PROPS,
    limit: 100,
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
  };
}

const headers = { 'Authorization': `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' };
async function hubGet(p)    { const r = await fetch(`${API}${p}`, {headers}); if(!r.ok) throw new Error(`GET ${p}: ${r.status}`); return r.json(); }
async function hubPost(p,b) { const r = await fetch(`${API}${p}`, {method:'POST',headers,body:JSON.stringify(b)}); if(!r.ok) throw new Error(`POST ${p}: ${r.status} ${await r.text()}`); return r.json(); }

async function fetchAllDeals(body) {
  const deals = []; let after = 0;
  while (true) {
    const data = await hubPost('/crm/v3/objects/deals/search', { ...body, after });
    deals.push(...(data.results || []));
    console.log(`  … ${deals.length} deals`);
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return deals;
}

async function fetchOwners() {
  const map = {}; let after;
  while (true) {
    const url = after ? `/crm/v3/owners?limit=100&after=${after}` : '/crm/v3/owners?limit=100';
    const data = await hubGet(url);
    for (const o of data.results || []) map[o.id] = `${o.firstName||''} ${o.lastName||''}`.trim() || o.email;
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return map;
}

// Extrai campanha do nome do deal: "Empresa - Campanha" → "Campanha"
function extractCampaign(dealname) {
  if (!dealname) return '— sem campanha';
  const parts = dealname.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : '— sem campanha';
}

function transformDeal(raw, owners) {
  const p = raw.properties || {};
  const stages = {};
  for (const id of ALL_STAGE_IDS) {
    const val = p[`hs_v2_date_entered_${id}`];
    if (val) stages[id] = val;
  }

  const currentStage = p.dealstage;
  const isSDRLost = !!stages[STAGE_SDR_LOST];
  const isOPPLost = currentStage === STAGE_OPP_LOST || !!stages[STAGE_OPP_LOST];
  const isLost = isSDRLost || isOPPLost;

  let lostStage = null, lostFunnel = null;
  if (isLost) {
    const active = Object.entries(stages)
      .filter(([id]) => id !== STAGE_SDR_LOST && id !== STAGE_OPP_LOST)
      .sort((a,b) => new Date(b[1]) - new Date(a[1]));
    if (active.length) {
      const allS = [...STAGES_SDR, ...STAGES_OPP];
      lostStage = allS.find(s => s.id === active[0][0])?.name || active[0][0];
    }
    lostFunnel = isOPPLost ? 'OPP' : 'SDR';
  }

  const ownerId = p.hubspot_owner_id;
  const ownerName = owners[ownerId] || (ownerId ? `Owner ${ownerId}` : null);
  const evId = p.ev_responsavel;
  const evName = evId ? (owners[evId] || evId) : ownerName;
  const createMonth = p.createdate ? p.createdate.slice(0,7) : null;

  return {
    id: raw.id,
    company: p.dealname || '— sem nome',
    campaign: extractCampaign(p.dealname),
    porte: p.porte || null,
    setor: p.setor || '— sem categoria',
    cn: ownerName, ev: evName,
    stages, amount: Number(p.amount) || 0,
    isLost, lostStage, lostFunnel,
    lostReason: isLost ? (p.closed_lost_reason || null) : null,
    createdate: p.createdate || null,
    createMonth,
  };
}

function countBusinessDays(from, to) {
  let c = 0; const d = new Date(from), end = new Date(to);
  while (d <= end) { if (d.getDay()!==0 && d.getDay()!==6) c++; d.setDate(d.getDate()+1); }
  return c;
}

async function main() {
  console.log('🔄 Painel Prospecção v2 — sync HubSpot\n');

  // Targets multi-mês
  const allTargets = JSON.parse(readFileSync(resolve(ROOT, 'targets.json'), 'utf-8'));
  console.log(`📅 Metas: ${Object.keys(allTargets).join(', ')}\n`);

  console.log('👥 Buscando owners…');
  const owners = await fetchOwners();
  console.log(`   ${Object.keys(owners).length} owners\n`);

  console.log('📊 Buscando deals (origem=Prospecção, origem_micro_=Motor sinais)…');
  const rawDeals = await fetchAllDeals(buildSearchBody());
  console.log(`   ${rawDeals.length} deals\n`);
  

  const deals = rawDeals.map(d => transformDeal(d, owners));

  // Porte counts
  const porteCounts = { all: deals.length };
  const porteSet = new Set();
  deals.forEach(d => { if (d.porte) { porteSet.add(d.porte); porteCounts[d.porte] = (porteCounts[d.porte]||0)+1; } });

  // Available months
  const months = [...new Set(deals.map(d => d.createMonth).filter(Boolean))].sort();

  // Business days per month (for targets that exist)
  const today = new Date().toISOString().slice(0,10);
  const monthMeta = {};
  for (const [m, cfg] of Object.entries(allTargets)) {
    const start = `${m}-01`;
    const lastDay = new Date(+m.split('-')[0], +m.split('-')[1], 0).getDate();
    const end = `${m}-${String(lastDay).padStart(2,'0')}`;
    const eff = today > end ? end : today < start ? start : today;
    monthMeta[m] = {
      label: cfg.label, start, end, businessDays: cfg.businessDays,
      businessDaysElapsed: countBusinessDays(start, eff),
      targets: cfg.targets,
    };
  }

  const campaigns = [...new Set(deals.map(d => d.campaign).filter(Boolean))].sort();
  const cns = [...new Set(deals.map(d => d.cn).filter(Boolean))].sort();
  const evs = [...new Set(deals.map(d => d.ev).filter(Boolean))].sort();
  const setores = [...new Set(deals.map(d => d.setor).filter(Boolean))].sort();

  const data = {
    meta: {
      updatedAt: new Date().toISOString(),
      availablePortes: [...porteSet].sort(),
      porteCounts,
      availableMonths: months,
      monthMeta,
    },
    deals,
    filters: { campaigns, cns, evs, setores },
    debug: { totalDeals: deals.length, query: 'origem=Prospecção AND origem_micro_=Motor sinais' },
  };

  writeFileSync(resolve(ROOT, 'data.json'), JSON.stringify(data, null, 2));
  console.log(`✅ data.json: ${deals.length} deals`);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
