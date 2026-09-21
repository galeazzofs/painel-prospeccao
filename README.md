# Painel de Prospecção — Pipo Saúde

Dashboard de monitoramento mensal de prospecção: **real vs meta + pace tracking**.

Hospedado no GitHub Pages, alimentado diariamente via GitHub Actions + HubSpot API.

## Stack

```
GitHub Pages   → hospeda o HTML (URL pública)
GitHub Actions → cron diário que puxa do HubSpot
HubSpot API    → fonte dos deals
targets.json   → metas mensais (editável)
```

Zero n8n, zero Cloudflare, zero servidor.

## Setup (uma vez)

### 1. Criar Private App no HubSpot

1. HubSpot → Settings → Integrations → Private Apps → Create
2. Nome: `Painel Prospecção`
3. Scopes: `crm.objects.deals.read`, `crm.objects.owners.read`
4. Copie o Access Token gerado

### 2. Configurar o repo

1. Vá em **Settings → Secrets → Actions** e crie:
   - `HUBSPOT_ACCESS_TOKEN` = o token copiado acima
   - `LEMLIST_API_KEY` = sua API key da Lemlist (em **Settings → Integrations** dentro do app da Lemlist)

2. Vá em **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main`, folder: `/ (root)`
   - Save

3. Ajuste `scripts/fetch.js`:
   - `PIPELINE_ID` → ID do seu pipeline de prospecção
   - Nomes das propriedades custom (`porte`, `setor`, `ev_responsavel`)
   - Filtros em `buildSearchFilter()` se precisar refinar

### 3. Primeiro sync

Vá em **Actions → Sync HubSpot → Run workflow** para rodar manualmente.
Se tudo der certo, o `data.json` será atualizado e o painel estará em:

```
https://galeazzofs.github.io/painel-prospeccao/
```

## Uso mensal

No início de cada mês, edite `targets.json` com as novas metas:

```json
{
  "month": "2026-10",
  "monthLabel": "Outubro 2026",
  "businessDays": 22,
  "targets": [
    { "id": "72557853", "name": "Mapeamento",     "target": 450 },
    { "id": "24595559", "name": "Em cadência",    "target": 380 },
    ...
  ]
}
```

Commit, push, e o próximo sync já usa as metas novas.

## Campanhas Lemlist

Página separada (`campanhas.html`) com stats de campanhas específicas da Lemlist — email e LinkedIn, por campanha.

Escalável: a lista de campanhas acompanhadas fica em `lemlist-campaigns.json`. Pra adicionar uma campanha nova:

```json
[
  { "id": "cam_kZdQkMjG5dPFMeMuT", "label": "Maturidade Estratégica" },
  { "id": "cam_efki5mPYHNt7TiGF5", "label": "Dores Operacionais" },
  { "id": "cam_kmjHZ4EsxnDGaHHpo", "label": "Renovação Próxima" },
  { "id": "cam_XXXXXXXXXXXXXXXXX", "label": "Nome da nova campanha" }
]
```

Commit, push, e o próximo sync (ou um `workflow_dispatch` manual) já traz os dados dela — nenhum código precisa mudar. O ID da campanha aparece na URL dela dentro do app da Lemlist (`cam_...`).

## Arquivos

| Arquivo | O que faz |
|---------|-----------|
| `index.html` | Dashboard de prospecção (HTML/CSS/JS puro, sem build) |
| `campanhas.html` | Dashboard de campanhas Lemlist (mesmo estilo, dados separados) |
| `data.json` | Dados do HubSpot (gerado automaticamente) |
| `lemlist-data.json` | Dados da Lemlist (gerado automaticamente) |
| `lemlist-campaigns.json` | Lista de campanhas Lemlist acompanhadas (editável) |
| `targets.json` | Metas do mês (editável manualmente) |
| `fetch.js` | Script que puxa do HubSpot |
| `fetch-lemlist.js` | Script que puxa da Lemlist |
| `.github/workflows/sync.yml` | Cron diário (8h e 14h BRT) — roda os dois fetches |
