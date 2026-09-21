#!/usr/bin/env node
// =============================================================================
// fetch-lemlist.js — Puxa stats de campanhas específicas da Lemlist (batch)
// Lista de campanhas configurável em lemlist-campaigns.json — escalável:
// pra acompanhar uma campanha nova, só adiciona { "id", "label" } no JSON.
// =============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const LEMLIST_API_KEY = process.env.LEMLIST_API_KEY;
if (!LEMLIST_API_KEY) { console.error('❌ LEMLIST_API_KEY não definido'); process.exit(1); }

const API = 'https://api.lemlist.com/api';
const AUTH = 'Basic ' + Buffer.from(':' + LEMLIST_API_KEY).toString('base64');

// Lifetime (sem filtro de data) — o front-end não filtra por período nesta página
const PERIOD_START = '2020-01-01T00:00:00.000Z';

const frac = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);

// Convites de LinkedIn ficam dentro de steps[], não em perChannel.linkedin
// (que só conta mensagens pós-conexão) — soma os steps do tipo linkedinInvite.
function sumLinkedinInvites(steps = []) {
  return steps
    .filter(s => s.taskType === 'linkedinInvite')
    .reduce((sum, s) => sum + (s.invited || s.sent || 0), 0);
}

function transform(raw, label) {
  const email = raw.perChannel?.email || {};
  const li = raw.perChannel?.linkedin || {};
  const invitesSent = sumLinkedinInvites(raw.steps);

  return {
    id: raw.campaignId,
    label,
    leads: {
      total: raw.nbLeads || 0,
      reached: raw.nbLeadsReached || 0,
      answered: raw.nbLeadsAnswered || 0,
      interested: raw.nbLeadsInterested || 0,
      interrupted: raw.nbLeadsInterrupted || 0,
    },
    email: {
      sent: email.sent || 0,
      delivered: email.delivered || 0,
      bounced: email.bounced || 0,
      opened: email.opened || 0,
      clicked: email.clicked || 0,
      replied: email.replied || 0,
      deliveryRate: frac(email.delivered, email.sent),
      bounceRate: frac(email.bounced, email.sent),
      openRate: frac(email.opened, email.delivered),
      clickRate: frac(email.clicked, email.delivered),
      replyRate: frac(email.replied, email.delivered),
    },
    linkedin: {
      invitesSent,
      invitesAccepted: li.invitationAccepted || 0,
      messagesSent: li.sent || 0,
      messagesReplied: li.replied || 0,
      acceptanceRate: frac(li.invitationAccepted, invitesSent),
      replyRate: frac(li.replied, li.sent),
    },
    meetingBooked: raw.meetingBooked || 0,
  };
}

async function main() {
  console.log('🔄 Painel Prospecção — sync Lemlist\n');

  const config = JSON.parse(readFileSync(resolve(ROOT, 'lemlist-campaigns.json'), 'utf-8'));
  const campaignIds = config.map(c => c.id);
  if (!campaignIds.length) { console.error('❌ lemlist-campaigns.json está vazio'); process.exit(1); }

  console.log(`📋 ${campaignIds.length} campanhas configuradas: ${config.map(c => c.label).join(', ')}\n`);

  const body = {
    campaignIds,
    startDate: PERIOD_START,
    endDate: new Date().toISOString(),
  };

  console.log('📊 Buscando stats na Lemlist (batch)…');
  const res = await fetch(`${API}/v2/campaigns/stats/batch`, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /v2/campaigns/stats/batch: ${res.status} ${await res.text()}`);
  const { results = [], errors = [] } = await res.json();

  if (errors.length) console.warn('⚠️  Erros retornados pela Lemlist:', errors);

  const byId = Object.fromEntries(results.map(r => [r.campaignId, r]));
  const campaigns = config
    .map(c => {
      const raw = byId[c.id];
      if (!raw) { console.warn(`⚠️  Sem dados para "${c.label}" (${c.id}) — verifique o ID`); return null; }
      return transform(raw, c.label);
    })
    .filter(Boolean);

  console.log(`   ${campaigns.length}/${config.length} campanhas com dados\n`);

  const data = {
    meta: {
      updatedAt: new Date().toISOString(),
      period: { start: body.startDate, end: body.endDate },
    },
    campaigns,
  };

  writeFileSync(resolve(ROOT, 'lemlist-data.json'), JSON.stringify(data, null, 2));
  console.log(`✅ lemlist-data.json: ${campaigns.length} campanhas`);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
