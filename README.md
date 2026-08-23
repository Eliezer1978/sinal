# Sinal

Um clipping diário próprio. Todo dia às 6h da manhã, um robô do GitHub visita
os feeds oficiais de cerca de 80 seções de veículos nacionais e internacionais,
junta o que saiu, descarta repetição, agrupa as matérias que tratam do mesmo
fato, classifica tudo em 12 temas, traduz o que veio de fora e publica uma
página onde você escolhe, na hora, quais temas e quais fontes quer ver.

O site é estático. Não há servidor, não há banco de dados, não há chave de API
no navegador. É um arquivo JSON e três arquivos de front-end.

---

## Publicar pela primeira vez

São seis passos. Leva por volta de quinze minutos, e depois disso nunca mais.

### 1. Criar o repositório

Crie um repositório novo no GitHub — pode ser privado, o GitHub Pages funciona
igual em conta paga e é gratuito em repositório público. Depois, na pasta deste
projeto:

```bash
git init
git add .
git commit -m "Sinal: primeira versão"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/sinal.git
git push -u origin main
```

### 2. Ligar o GitHub Pages

No repositório: **Settings → Pages → Source** e escolha **GitHub Actions**.
Não escolha "Deploy from a branch" — o fluxo aqui publica via Actions.

### 3. Dar permissão de escrita ao robô

**Settings → Actions → General**, role até **Workflow permissions** e marque
**Read and write permissions**. É isso que permite ao robô guardar a edição do
dia no repositório, para que o site continue no ar mesmo se uma coleta falhar.

### 4. Guardar a chave da API (opcional, mas é o que traz a tradução)

**Settings → Secrets and variables → Actions → New repository secret**

- Nome: `ANTHROPIC_API_KEY`
- Valor: sua chave, obtida em <https://console.anthropic.com>

Sem essa chave o site funciona normalmente — só que as matérias estrangeiras
aparecem no idioma original e não há análise do dia. Nada quebra.

### 5. Rodar a primeira coleta na mão

Aba **Actions → Coleta diária → Run workflow**. A primeira execução leva de dois
a quatro minutos. Ao final, o resumo da execução mostra quantas matérias
entraram e quais fontes não responderam.

### 6. Abrir o site

`https://SEU-USUARIO.github.io/sinal/`

A partir daí ele se atualiza sozinho todo dia às 6h.

---

## O que fazer quando alguma coisa não funcionar

**Nenhuma fonte respondeu.** Quase sempre é a permissão do passo 3 ou a chave
do passo 4 com nome errado. O resumo da execução em Actions diz qual foi o erro
de cada fonte, uma por uma.

**Algumas fontes falham sempre.** Normal, e previsto. Veículos mudam o endereço
do feed sem avisar e alguns bloqueiam robôs. Abra `collector/feeds.json`,
localize a fonte pelo `id` e conserte a URL — ou troque o tipo para `gnews`
(explicado adiante), que quase sempre funciona. Uma fonte quebrada nunca derruba
a coleta: ela aparece marcada em "Situação das fontes", no rodapé do site.

**O site diz "Ainda não há edição publicada".** Falta rodar o passo 5.

**A página não atualiza no horário.** O GitHub agenda em UTC e não segue horário
de verão. O `cron: '0 9 * * *'` do arquivo `.github/workflows/coleta.yml`
equivale a 6h de Brasília enquanto o Brasil estiver em UTC−3. Se o horário de
verão voltar, troque para `'0 8 * * *'`. Vale saber também que o agendador do
GitHub atrasa alguns minutos em horários de pico — não é defeito.

---

## Mexer nas fontes

Tudo mora em `collector/feeds.json`. Cada fonte é um objeto:

```json
{
  "id": "guardian-world",
  "name": "The Guardian",
  "group": "global",
  "type": "rss",
  "url": "https://www.theguardian.com/world/rss",
  "section": "Mundo",
  "lang": "en",
  "weight": 0.9,
  "paywall": false,
  "site": "https://www.theguardian.com",
  "hint": ["geopolitica"]
}
```

- **`weight`** é o peso editorial, de 0,5 a 1,0. Entra no ranking e decide qual
  veículo vira a matéria principal quando vários cobrem o mesmo fato. É o botão
  mais direto para dizer "confio mais nesse".
- **`hint`** são os temas que a fonte costuma cobrir. Dá um empurrão na
  classificação, mas nunca inventa tema do nada: só reforça o que o texto já
  sugeriu, ou serve de último recurso quando o texto não sugeriu nada.
- **`section`** é só rótulo, aparece ao lado do nome do veículo.

### Quando o veículo não tem RSS

Reuters, AP, AFP e Bloomberg desativaram seus feeds públicos. Para esses, o tipo
é `gnews`, que monta uma busca no Google Notícias:

```json
{ "id": "reuters", "name": "Reuters", "type": "gnews", "query": "site:reuters.com", "lang": "en", "gl": "US" }
```

O `query` aceita a sintaxe de busca do Google: `site:`, `OR`, aspas para
expressão exata. É o caminho para adicionar praticamente qualquer veículo.

### Adicionar uma fonte nova

Copie um bloco existente, troque `id`, `name`, `url` e `hint`. O `id` precisa
ser único. Se o grupo ainda não existir, acrescente-o em `groups`, no topo do
arquivo. Nada mais precisa mudar: a barra lateral se monta sozinha a partir
desse arquivo.

---

## Mexer nos temas

`collector/topics.json`. Cada tema tem duas listas de termos:

- **`strong`** — termos que sozinhos já indicam o tema. Valem 3 pontos.
- **`weak`** — termos de apoio, que só contam somados. Valem 1 ponto.

Uma matéria entra no tema quando soma 3 pontos ou mais. Ou seja: um termo forte
basta, ou três fracos. A comparação ignora acentos e maiúsculas, e termos com
espaço são casados como expressão inteira.

É aqui que se afina a pontaria. Se um tema estiver trazendo lixo, o culpado
quase sempre é um termo fraco genérico demais — mova para `strong` ou remova.
Se estiver trazendo pouco, acrescente sinônimos e as formas em inglês.

Para criar um tema novo, acrescente um bloco com `id`, `label`, `short`,
`description`, `strong` e `weak`. O chip aparece no site na coleta seguinte.

---

## Como o ranking funciona

Sem nenhuma IA. Cada matéria recebe uma nota entre 0 e 1, somando quatro
componentes com pesos fixos (definidos em `WEIGHTS`, no topo de
`collector/collect.mjs`):

| Componente | Peso | O que mede |
|---|---|---|
| Recência | 0,34 | Meia-vida de 12 horas: uma matéria de 12h vale metade de uma de agora |
| Peso da fonte | 0,26 | O `weight` que você definiu no registro |
| Relevância temática | 0,28 | Quanto o texto casou com os seus temas |
| Corroboração | 0,12 | Quantos veículos cobriram o mesmo fato |

Depois disso, um teto de 25 matérias por fonte impede que um feed prolífico
domine a página, e um teto global de 700 mantém o JSON leve.

### Agrupamento

Duas matérias entram no mesmo grupo quando metade das palavras de conteúdo da
mais curta aparece na mais longa, com pelo menos três palavras em comum e menos
de 36 horas entre elas. A de maior peso editorial vira a principal; as outras
viram "também em N outros".

A comparação é lexical, então **não cruza idiomas por conta própria**. A versão
brasileira de uma notícia americana só se junta ao grupo depois de traduzida —
por isso, com a chave de API ligada, roda um segundo passe de agrupamento sobre
os títulos em português. Sem a chave, as duas versões aparecem separadas.

---

## A camada de IA

Roda uma vez por dia, dentro da coleta, e faz duas coisas: traduz título e
resumo das matérias estrangeiras, e escreve a análise do dia que aparece no
botão "Curadoria IA".

O resultado fica gravado no JSON. O botão no site apenas mostra ou esconde um
texto que já está pronto — nenhuma chamada de API acontece no navegador, e sua
chave nunca sai do GitHub.

### Volume e custo

Com os padrões atuais (400 matérias traduzidas, lotes de 20), um dia consome
aproximadamente 60 mil tokens de entrada e 40 mil de saída, distribuídos em umas
21 chamadas. O custo depende do modelo escolhido e dos preços vigentes —
confira em <https://www.anthropic.com/pricing>. Com um modelo da linha Haiku
fica na casa de centavos de dólar por dia.

Para gastar menos, reduza `MAX_TRANSLATE` no arquivo do workflow. Com 150, você
traduz só o topo da página e o resto fica no original.

### Escolha do modelo

Por padrão o script consulta a API, vê quais modelos sua conta tem disponíveis e
escolhe sozinho: o mais recente da linha Haiku para traduzir, o mais recente da
linha Sonnet para a análise. Assim nada quebra quando os nomes mudam. Para
fixar um modelo específico, defina `TRANSLATE_MODEL` e `BRIEFING_MODEL` no
workflow.

### Desligar a IA num dia específico

Em **Actions → Coleta diária → Run workflow**, marque "Rodar sem a camada de IA".

---

## Rodar na sua máquina

Precisa de Node 20 ou mais novo.

```bash
npm install
npm run coletar          # busca os feeds e gera site/data/latest.json
npm run ia               # traduz e escreve a análise (precisa de ANTHROPIC_API_KEY)
npm run edicao           # os dois de uma vez
npm run servir           # coleta e abre em http://localhost:5173
npm test                 # testa o pipeline inteiro contra feeds simulados
npm run preview          # gera a prévia de arquivo único com dados fictícios
```

Variáveis de ambiente úteis:

| Variável | Padrão | Efeito |
|---|---|---|
| `WINDOW_HOURS` | 48 | Idade máxima de uma matéria |
| `PER_SOURCE_CAP` | 25 | Teto de matérias por fonte |
| `GLOBAL_CAP` | 700 | Teto total |
| `CONCURRENCY` | 8 | Feeds buscados em paralelo |
| `MAX_TRANSLATE` | 400 | Teto de matérias traduzidas |
| `KEEP_DAYS` | 30 | Dias de arquivo mantidos |

---

## Estrutura

```
collector/
  feeds.json          registro das fontes — o arquivo que você mais vai mexer
  topics.json         dicionário de termos por tema
  collect.mjs         busca, normaliza, deduplica, classifica e ranqueia
  cluster.mjs         agrupamento de matérias sobre o mesmo fato
  enrich.mjs          tradução e análise do dia (opcional)
  prune.mjs           limpeza do arquivo antigo
  build-preview.mjs   gera a prévia de arquivo único
site/
  index.html          estrutura da página
  styles.css          identidade visual, temas claro e escuro
  app.js              filtros, busca, ordenação, tudo no navegador
  data/latest.json    a edição atual (gerada, não edite)
  data/archive/       últimos 30 dias
test/
  mock-feeds.mjs      servidor de feeds falsos, com defeitos propositais
  run.mjs             39 verificações do pipeline
  shot.mjs            abre a prévia num Chromium e confere a interface
.github/workflows/
  coleta.yml          a automação diária
```

---

## Sobre direitos

O site guarda e exibe apenas o que os próprios veículos publicam em seus feeds:
manchete, resumo curto e link. Todo item leva ao original, com o crédito do
veículo em destaque. Não há cópia de texto integral, não há remoção de paywall e
não há republicação. É a mesma coisa que um leitor de RSS faz — a diferença é
que este organiza por tema.
