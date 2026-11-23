// ============================================================
// Economia de acoes do turno: o que o personagem pode fazer com a Acao,
// a Acao Bonus, a Reacao e de graca.
//
// Modulo PURO: sem DOM, sem `char`, sem fetch. Recebe `personagem` e os
// dados ja carregados por quem chama (sheet/acoes-turno.js) e devolve
// estrutura pronta para renderizar. Toda regra de classe passa por
// nivelNa/subclasseDe/temClasse, nunca por char.classe/char.nivel.
// ============================================================

/**
 * Tira acentos e caixa de um texto para comparacao. As descricoes do livro
 * misturam "Acao Bonus", "acao bonus" e "Ação Bônus" -- comparar na forma
 * normalizada evita uma lista de variantes em cada regex.
 */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Classifica o campo `tempo_conjuracao` do acervo de magias numa das faixas
 * da economia de acoes. O campo e texto livre no livro: alem de "Acao" e
 * "Acao Bonus" secos, aparecem caudas longas ("Acao Bonus, que voce realiza
 * imediatamente apos atingir uma criatura...") e sujeira de extracao de PDF
 * ("ama Acao", "1 acao"). A ordem dos testes importa: "Acao Bonus" contem
 * "acao", entao o bonus e testado ANTES.
 *
 * @param {string} tempo Valor de `tempo_conjuracao` do acervo.
 * @returns {'acao'|'bonus'|'reacao'|'ritual'|'fora_de_combate'} Faixa.
 *   `fora_de_combate` cobre os tempos em minutos/horas, que nao cabem num
 *   turno e por isso NAO entram no painel de combate.
 */
export function classificarTempoConjuracao(tempo) {
  const t = normalizar(tempo);
  if (!t) return 'acao';
  if (t.includes('acao bonus')) return 'bonus';
  if (t.startsWith('reacao')) return 'reacao';
  // "Acao ou Ritual" vale como Acao em combate -- o ritual e a via lenta
  // (10 min a mais), nunca a opcao de turno. So vira 'ritual' quando NAO ha
  // alternativa de acao ("1 minuto ou Ritual").
  if (t.includes('acao')) return 'acao';
  if (t.includes('ritual')) return 'ritual';
  return 'fora_de_combate';
}

// Verbos que indicam que a frase esta descrevendo COMO SE USA a
// caracteristica, nao citando a economia de acoes de passagem. Sem esse
// escopo, "Defesa Paciente ... voce pode gastar um Ponto de Foco" dentro da
// descricao de Foco do Monge marcaria Foco do Monge como Acao Bonus, que e
// o mesmo tipo de falso positivo que detectarRecarga (utils.js) descreve
// para a recarga por descanso.
const VERBOS_DE_USO = /\b(voce pode|voce usa|pode usar|usando|gastar|gaste|realiza|realizar|execut|gasta)\b/;

/**
 * Detecta o custo em economia de acoes a partir da descricao de uma
 * caracteristica de classe, subclasse, especie ou talento. O acervo nao tem
 * campo estruturado para isso -- o custo so existe na prosa do livro --,
 * entao a deteccao e por texto e deliberadamente CONSERVADORA: na duvida
 * devolve null e a caracteristica nao entra no painel, em vez de entrar na
 * faixa errada e ensinar a regra errada ao jogador.
 *
 * Duas formas sao aceitas, e so elas:
 *  (a) a frase ABRE anunciando o custo -- "Como uma Acao Bonus, voce...",
 *      "Com uma Reacao, ...";
 *  (b) a frase tem o custo E um verbo de uso perto -- "voce pode usar uma
 *      Acao Bonus para...".
 *
 * @param {string} descricao Texto da caracteristica.
 * @returns {'acao'|'bonus'|'reacao'|null} Custo, ou null quando o texto nao
 *   deixa claro (caso em que quem chama simplesmente nao lista).
 */
export function custoAcaoDeTexto(descricao) {
  const d = normalizar(descricao);
  if (!d) return null;

  // Uma faixa por vez, da mais especifica para a mais generica: "acao
  // bonus" contem "acao", e "reacao" tambem -- testar fora de ordem
  // classificaria toda Acao Bonus como Acao.
  const faixas = [
    { custo: 'bonus', termo: 'acao bonus' },
    { custo: 'reacao', termo: 'reacao' },
    { custo: 'acao', termo: 'acao' },
  ];

  // Quebra em frases para medir a vizinhanca do termo: o verbo de uso tem
  // de estar na MESMA frase que o custo, nao a tres paragrafos de distancia.
  const frases = d.split(/(?<=\.)\s+|\n/);

  for (const { custo, termo } of faixas) {
    for (const frase of frases) {
      const pos = frase.indexOf(termo);
      if (pos === -1) continue;

      // Uma faixa mais especifica ja descartada nao pode ser recontada aqui:
      // se a frase diz "acao bonus" e estamos testando 'acao', esta frase ja
      // foi julgada na volta anterior do laco de fora.
      if (custo === 'acao' && frase.includes('acao bonus')) continue;
      if (custo === 'acao' && frase.includes('reacao')) continue;

      // (a) a frase ABRE com o anuncio do custo.
      const abertura = /^\s*(como|com|usando|gastando)\s+(uma|sua|a)\s/.test(frase)
        && pos < 40;
      // (b) custo e verbo de uso na mesma frase.
      const comVerbo = VERBOS_DE_USO.test(frase);

      if (abertura || comVerbo) return custo;
    }
  }
  return null;
}

/**
 * O que cada condicao TIRA do turno. So entram as condicoes cujo efeito
 * mexe na economia de acoes -- Envenenado e Amedrontado dao Desvantagem,
 * que e relevante na rolagem mas nao bloqueia nada, e por isso ficam de
 * fora: o painel responde "o que posso fazer", nao "com que bonus".
 *
 * Fonte: glossario de condicoes do Livro do Jogador 2024, o mesmo que
 * alimenta CONDICOES_DESCRICAO em sheet/condicoes.js.
 */
const LIMITES_CONDICAO = {
  'Incapacitado': { acao: true, bonus: true, reacao: true, motivo: 'Incapacitado: sem Ação, Ação Bônus ou Reação.' },
  'Atordoado': { acao: true, bonus: true, reacao: true, motivo: 'Atordoado: você fica Incapacitado.' },
  'Paralisado': { acao: true, bonus: true, reacao: true, motivo: 'Paralisado: você fica Incapacitado.' },
  'Petrificado': { acao: true, bonus: true, reacao: true, motivo: 'Petrificado: você fica Incapacitado.' },
  'Inconsciente': { acao: true, bonus: true, reacao: true, movimento: true, motivo: 'Inconsciente: Incapacitado e Deslocamento 0.' },
  'Contido': { movimento: true, motivo: 'Contido: Deslocamento 0.' },
  'Imobilizado': { movimento: true, motivo: 'Imobilizado: Deslocamento 0.' },
  'Caído': { motivo: 'Caído: só rastejar, ou metade do Deslocamento para levantar.' },
};

/**
 * Cruza as condicoes ativas do personagem com a economia de acoes e diz o
 * que esta bloqueado no turno e por que. Quem chama usa isso para marcar as
 * faixas do painel como indisponiveis, em vez de listar opcoes que a
 * condicao ja proibe.
 *
 * @param {string[]} condicoes Nomes das condicoes ativas (`char.condicoes`).
 * @param {number} exaustao Nivel de Exaustao (0 a 6).
 * @returns {{acao:boolean, bonus:boolean, reacao:boolean, movimento:boolean, motivos:string[]}}
 */
export function limitesDoTurno(condicoes, exaustao) {
  const ativas = Array.isArray(condicoes) ? condicoes : [];
  const limites = { acao: false, bonus: false, reacao: false, movimento: false, motivos: [] };

  for (const nome of ativas) {
    const lim = LIMITES_CONDICAO[nome];
    if (!lim) continue;
    if (lim.acao) limites.acao = true;
    if (lim.bonus) limites.bonus = true;
    if (lim.reacao) limites.reacao = true;
    if (lim.movimento) limites.movimento = true;
    if (lim.motivo) limites.motivos.push(lim.motivo);
  }

  // Exaustao nao bloqueia faixa nenhuma na regra 2024 (ela corta testes de
  // D20 e Deslocamento), mas nivel 6 e morte -- avisar e mais util do que
  // deixar o painel mudo.
  const nivelExaustao = Number(exaustao) || 0;
  if (nivelExaustao > 0) {
    limites.motivos.push(`Exaustão ${nivelExaustao}: -${nivelExaustao * 2} em testes de D20, -${(nivelExaustao * 1.5).toLocaleString('pt-BR')} m de Deslocamento.`);
  }

  return limites;
}

/**
 * Separa as magias preparadas/conhecidas do personagem pela faixa de
 * economia de acoes, usando o `tempo_conjuracao` do acervo. So entram as
 * que cabem num turno -- as de minutos ou horas sao descartadas, porque o
 * painel existe para o combate.
 *
 * PURA: recebe a lista de magias do personagem e o indice do acervo ja
 * carregado; nao busca nada.
 *
 * @param {Array<{nome:string, classe?:string}>} magiasDoPersonagem Entradas
 *   de `magias_preparadas` / truques conhecidos.
 * @param {Array<{nome:string, tempo_conjuracao:string, circulo:number}>} indice
 *   `magias` de `dados/magias/_indice.json`.
 * @returns {{acao:Array, bonus:Array, reacao:Array}} Cada balde com
 *   `{nome, circulo, tempo}`, ordenado por circulo e depois por nome.
 */
export function magiasPorFaixaDeAcao(magiasDoPersonagem, indice) {
  const porNome = new Map();
  for (const m of Array.isArray(indice) ? indice : []) {
    if (m?.nome) porNome.set(normalizar(m.nome), m);
  }

  const baldes = { acao: [], bonus: [], reacao: [] };
  const vistos = new Set();

  for (const entrada of Array.isArray(magiasDoPersonagem) ? magiasDoPersonagem : []) {
    const nome = typeof entrada === 'string' ? entrada : entrada?.nome;
    if (!nome) continue;
    const chave = normalizar(nome);
    // Uma magia preparada por duas classes aparece duas vezes em
    // `magias_preparadas` -- no painel ela e UMA opcao de turno.
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const doAcervo = porNome.get(chave);
    if (!doAcervo) continue;

    const faixa = classificarTempoConjuracao(doAcervo.tempo_conjuracao);
    if (!baldes[faixa]) continue; // ritual e fora_de_combate nao entram

    baldes[faixa].push({
      nome: doAcervo.nome,
      circulo: doAcervo.circulo ?? 0,
      tempo: doAcervo.tempo_conjuracao || '',
    });
  }

  for (const faixa of Object.keys(baldes)) {
    baldes[faixa].sort((a, b) => (a.circulo - b.circulo) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  return baldes;
}

/**
 * Estado inicial do turno. Campo novo de personagem: quem le usa optional
 * chaining e quem escreve garante o objeto antes (ver sheet/acoes-turno.js
 * e sheet/migracoes.js).
 *
 * NAO existe mais `em_combate`: o painel marca o gasto direto na confirmacao
 * da opcao, sem modo para ligar antes. Fichas salvas com o campo antigo
 * continuam abrindo -- ele vira uma chave ignorada em `char.turno`, e o
 * primeiro "Novo turno" a apaga, porque salvarTurno reescreve a partir
 * deste zerado.
 */
export function turnoZerado() {
  return { acao_usada: false, bonus_usada: false, reacao_usada: false };
}

/**
 * As reservas que podem pagar uma magia de `circuloMinimo`: o livro permite
 * conjurar em circulo IGUAL ou MAIOR (ampliar), nunca menor. Truque
 * (circulo 0) nao gasta espaco e por
 * 
 * 
 *  isso devolve lista vazia -- quem chama
 * trata "sem escolha" como "nao ha o que gastar", nao como "sem espaco".
 *
 * PURA: recebe as reservas ja montadas (sheet/reservas-espacos.js) e so
 * filtra e ordena, para o painel nao reimplementar a prioridade de fonte.
 *
 * @param {Array<{fonte:string, circulo:number, disponiveis:number}>} reservas
 * @param {number} circuloMinimo Circulo base da magia.
 * @returns {Array<{fonte:string, circulo:number, disponiveis:number}>} Da
 *   reserva mais barata para a mais cara; entre fontes do mesmo circulo, a
 *   ordem alfabetica ('conjuracao' antes de 'pacto') mantem o espaco comum
 *   como primeira sugestao, poupando o do Bruxo.
 */
export function escolhasDeEspaco(reservas, circuloMinimo) {
  const minimo = Number(circuloMinimo) || 0;
  if (minimo <= 0) return [];
  return (Array.isArray(reservas) ? reservas : [])
    .filter((r) => r && Number(r.circulo) >= minimo && Number(r.disponiveis) > 0)
    .sort((a, b) => a.circulo - b.circulo || String(a.fonte).localeCompare(String(b.fonte)));
}

/**
 * Esta magia pode ser conjurada AGORA? Truque sempre pode (nao gasta
 * espaco); de 1o circulo para cima, so com espaco igual ou maior livre.
 *
 * @param {{circulo:number}} magia Entrada de `magiasPorFaixaDeAcao`.
 * @param {Array<{fonte:string, circulo:number, disponiveis:number}>} reservas
 * @returns {boolean}
 */
export function magiaConjuravel(magia, reservas) {
  const circulo = Number(magia?.circulo) || 0;
  return circulo === 0 || escolhasDeEspaco(reservas, circulo).length > 0;
}

/**
 * Por que a acao "Usar Magia" do livro nao esta disponivel -- `''` quando
 * esta. Separa as duas causas, que pedem reacoes diferentes do jogador:
 * sem NENHUMA magia na ficha (preparar magias resolve) e sem ESPACO para
 * as que existem (so descanso resolve).
 *
 * PURA: recebe os baldes de `magiasPorFaixaDeAcao` e as reservas ja
 * montadas, nao busca nada.
 *
 * @param {{acao:Array, bonus:Array, reacao:Array}} magias Baldes por faixa.
 * @param {Array<{fonte:string, circulo:number, disponiveis:number}>} reservas
 * @returns {string} Texto curto para o card, ou '' quando ha o que conjurar.
 */
export function motivoSemConjuracao(magias, reservas) {
  const todas = [
    ...(magias?.acao || []),
    ...(magias?.bonus || []),
    ...(magias?.reacao || []),
  ];
  if (todas.length === 0) return 'Nenhuma magia nesta ficha';
  if (todas.some((m) => magiaConjuravel(m, reservas))) return '';
  return 'Sem espaço de magia disponível';
}
