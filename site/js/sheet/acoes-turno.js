// ============================================================
// Painel "Meu Turno": o que o personagem pode fazer com a Ação, a Ação
// Bônus, a Reação, o Movimento e de graça.
//
// Camada de tela do modulo puro regras-acoes-turno.js: carrega os dados do
// livro, le a ficha e monta o painel. A classificacao em si (o que e Acao,
// o que e Bonus) mora la, sem DOM, para poder ser testada fora do browser.
//
// Nao ha "Modo Combate" para ligar antes: clicar na opcao abre o popup com
// a descricao e a confirmacao, e confirmar gasta TUDO o que ela custa --
// a faixa do turno, o espaco de magia e o uso da caracteristica (quem
// desconta cada um e sheet/consumo-turno.js, que escreve nos mesmos
// campos dos chips de recurso da ficha).
// ============================================================
import { getAcoesDoLivro, getIndiceMagias } from '../db.js';
import { custoAcaoDeTexto, limitesDoTurno, magiaConjuravel, magiasPorFaixaDeAcao, motivoSemConjuracao, turnoZerado } from '../regras-acoes-turno.js';
import { deslocamentoComQuadrados } from '../regras-distancia.js';
import { abrirModal, escHtml, fecharModalTodos, getDeslocamento, toast } from '../utils.js';
import { char, especiesCache, salvar } from './estado.js';
import { gerarTracoSinteticoEspecie } from './caracteristicas.js';
import { getAtaquesPorAcao, getDeslocamentoFinal } from './combate.js';
import { consumirEspacoDeMagia, consumirUso, contagemDeUso, espacosParaMagia } from './consumo-turno.js';
import { contextosDeClasse } from './contexto-classe.js';
import { renderFichaCompleta } from './ficha.js';
import { reservasDeEspacos } from './reservas-espacos.js';

// As 12 acoes do livro e o indice de magias sao os mesmos para qualquer
// ficha e nao mudam durante a sessao. fetchJSON (db.js) ja tem cache em
// memoria, mas guardar aqui tambem evita refazer a varredura da tabela a
// cada abertura do painel.
let _acoesLivro = null;
let _indiceMagias = null;

// Campo de `char.turno` que cada faixa marca. 'livre' nao entra: movimento
// e interacao gratis nao consomem nada do turno.
const CAMPO_DA_FAIXA = { acao: 'acao_usada', bonus: 'bonus_usada', reacao: 'reacao_usada' };
const NOME_DA_FAIXA = { acao: 'Ação', bonus: 'Ação Bônus', reacao: 'Reação' };

/**
 * Estado do turno da ficha aberta. Campo novo de personagem: a leitura usa
 * optional chaining e cai no zerado quando a ficha e antiga (nenhuma
 * migracao necessaria -- o campo e aditivo e so passa a existir na
 * primeira opcao confirmada).
 */
function estadoTurno() {
  return { ...turnoZerado(), ...(char?.turno || {}) };
}

/** Grava o estado do turno, criando o campo na primeira escrita. */
function salvarTurno(novo) {
  char.turno = { ...estadoTurno(), ...novo };
  salvar();
}

/** As tres faixas gastas agora, para o FAB e o resumo do painel. */
function faixasGastas() {
  const t = estadoTurno();
  return [t.acao_usada, t.bonus_usada, t.reacao_usada].filter(Boolean).length;
}

/**
 * Varre classes, subclasses e especie do personagem e separa as
 * caracteristicas por custo em economia de acoes, usando custoAcaoDeTexto.
 *
 * O nivel que libera cada caracteristica e o NAQUELA classe
 * (ctx.nivelClasse), nunca o total do personagem -- mesma regra que
 * restaurarHabilidades (hp-descanso.js) segue: num Barbaro 2/Guerreiro 3 as
 * caracteristicas do Guerreiro valem pelo nivel 3 de Guerreiro.
 *
 * @returns {{acao:Array, bonus:Array, reacao:Array}} Cada item
 *   `{nome, origem, descricao, classe, fonteUso}`. `classe` e `fonteUso`
 *   existem para sheet/consumo-turno.js achar o contador de uso certo:
 *   o dedicado da classe dona, ou a chave `${fonteUso}_${nome}` em
 *   `char.usos_habilidades` -- a MESMA que o card de Caracteristicas usa.
 */
export function caracteristicasPorFaixa() {
  const baldes = { acao: [], bonus: [], reacao: [] };
  const vistos = new Set();

  const adicionar = (nome, descricao, origem, { classe = '', fonteUso = 'classe' } = {}) => {
    const custo = custoAcaoDeTexto(descricao);
    if (!custo || !baldes[custo]) return;
    // Uma caracteristica com o mesmo nome em duas classes (ex.: Ataque
    // Extra) e UMA opcao de turno, nao duas linhas iguais no painel.
    const chave = `${custo}|${nome}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);
    baldes[custo].push({ nome, origem, descricao, classe, fonteUso });
  };

  for (const ctx of contextosDeClasse()) {
    if (!ctx.dados) continue;

    // Os JSONs de classe repetem as caracteristicas de subclasse DENTRO da
    // lista da classe (medido em dados/classes/monge.json: "Explosao
    // Elemental", do Combatente dos Elementos, esta nos dois lugares).
    // Filtrar so por nivel faria um Monge da Mao Espalmada ver as opcoes
    // das Sombras e dos Elementos no painel -- opcoes que ele nao tem.
    // Nomes que pertencem a uma subclasse QUE NAO E A DELE saem daqui; a
    // subclasse ativa entra logo abaixo, pelo caminho proprio.
    const deOutraSubclasse = new Set();
    for (const sc of (ctx.dados.subclasses || [])) {
      if (sc.nome === ctx.subclasse) continue;
      (sc.caracteristicas || []).forEach((c) => deOutraSubclasse.add(c.nome));
    }
    const daSubclasseAtiva = new Set(
      ((ctx.dados.subclasses || []).find((s) => s.nome === ctx.subclasse)?.caracteristicas || [])
        .map((c) => c.nome)
    );

    (ctx.dados.caracteristicas || [])
      .filter((c) => c.nivel <= ctx.nivelClasse)
      .filter((c) => !deOutraSubclasse.has(c.nome) || daSubclasseAtiva.has(c.nome))
      .forEach((c) => adicionar(c.nome, c.descricao, ctx.dados.nome || '',
        { classe: ctx.classe, fonteUso: 'classe' }));

    if (ctx.subclasse && ctx.dados.subclasses) {
      const sc = ctx.dados.subclasses.find((s) => s.nome === ctx.subclasse);
      (sc?.caracteristicas || [])
        .filter((c) => c.nivel <= ctx.nivelClasse)
        .forEach((c) => adicionar(c.nome, c.descricao, ctx.subclasse,
          { classe: ctx.classe, fonteUso: 'subclasse' }));
    }
  }

  // Tracos da especie, inclusive os sinteticos (Tiferino, Elfo), montados
  // pelo mesmo gerador que a aba de caracteristicas usa.
  if (char?.especie && especiesCache?.especies) {
    const esp = especiesCache.especies.find((e) => e.nome === char.especie);
    (esp?.tracos || []).forEach((t) => adicionar(t.nome, t.descricao, char.especie,
      { classe: '', fonteUso: 'especie' }));
  }
  if (char?.especie && char?.tracos_escolhidos?.length > 0) {
    const sinteticos = gerarTracoSinteticoEspecie(char.especie, char.tracos_escolhidos, char.nivel) || [];
    sinteticos.forEach((t) => adicionar(t.nome, t.descricao, char.especie,
      { classe: '', fonteUso: 'especie' }));
  }

  for (const faixa of Object.keys(baldes)) {
    baldes[faixa].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  return baldes;
}

/**
 * HTML do botao flutuante do painel, irmao do FAB de descanso. O destaque
 * agora e por TURNO EM ANDAMENTO (alguma faixa ja gasta), nao por um modo
 * que o jogador tenha ligado -- sem Modo Combate, e esse o unico estado
 * que ele precisa ver sem abrir o painel.
 */
export function renderFabAcoes() {
  const emAndamento = faixasGastas() > 0;
  return `
    <div id="fab-acoes" class="fab-acoes no-print">
      <button class="fab-btn ${emAndamento ? 'fab-btn-turno-gasto' : ''}" id="fab-toggle-acoes" title="Meu Turno: o que posso fazer">⚔️</button>
    </div>
  `;
}

/**
 * Cartao clicavel de uma opcao do turno; a descricao vai para popup.
 *
 * `desabilitado` e para a opcao que o personagem NAO PODE executar agora --
 * magia sem espaco, "Usar Magia" sem nada para conjurar. O card fica
 * inerte (`disabled`), e o subtitulo carrega o motivo: desabilitar sem
 * dizer por que deixaria o jogador procurando o que fez a opcao sumir.
 */
function cardOpcao(titulo, subtitulo, chaveDetalhe, { desabilitado = false } = {}) {
  return `
    <button class="acao-card${desabilitado ? ' acao-card-off' : ''}" data-acao-detalhe="${escHtml(chaveDetalhe)}"${desabilitado ? ' disabled' : ''}>
      <span class="acao-card-nome">${escHtml(titulo)}</span>
      ${subtitulo ? `<span class="acao-card-sub">${escHtml(subtitulo)}</span>` : ''}
    </button>
  `;
}

/** Subtitulo do card de uma magia: o circulo, ou o motivo de nao dar para
 *  conjurar agora. */
function subtituloMagia(m, conjuravel) {
  if (!conjuravel) return 'Sem espaço disponível';
  return m.circulo === 0 ? 'Truque' : `${m.circulo}º círculo`;
}

/**
 * Monta uma faixa do painel (Ação, Ação Bônus, Reação...). A faixa nasce
 * marcada como gasta ou bloqueada conforme o que ja foi confirmado nesta
 * rodada e as condicoes ativas -- o jogador ve de cara o que ainda tem.
 *
 * So a faixa JA GASTA ganha botao, e e o de desfazer: marcar e papel da
 * confirmacao no popup da opcao, nao de um botao generico aqui.
 */
function secaoFaixa({ id, titulo, icone, itens, gasta, bloqueada, motivo }) {
  const vazia = itens.length === 0;
  const classes = ['acao-faixa'];
  if (gasta) classes.push('acao-faixa-gasta');
  if (bloqueada) classes.push('acao-faixa-bloqueada');

  return `
    <div class="${classes.join(' ')}">
      <div class="acao-faixa-topo">
        <h3>${icone} ${escHtml(titulo)}</h3>
        ${gasta ? `<button class="btn btn-sm btn-secondary" data-devolver-faixa="${escHtml(id)}">↩ Devolver</button>` : ''}
        ${bloqueada ? '<span class="acao-selo-bloqueio">Bloqueada</span>' : ''}
      </div>
      ${motivo ? `<p class="acao-faixa-motivo">${escHtml(motivo)}</p>` : ''}
      ${vazia
        ? '<p class="acao-faixa-vazia">Nada específico da sua ficha nesta faixa.</p>'
        : `<div class="acao-cards">${itens.join('')}</div>`}
    </div>
  `;
}

// Guarda as opcoes da abertura atual do painel, para o popup de confirmacao
// nao precisar recarregar nem revarrer nada no clique.
let _detalhes = new Map();
// A opcao com o popup aberto agora, e o espaco de magia escolhido nele.
let _opcaoAberta = null;

/** Corpo do painel: referencia do livro + o que esta ficha pode fazer. */
function corpoDoPainel() {
  _detalhes = new Map();
  const turno = estadoTurno();

  const limites = limitesDoTurno(char?.condicoes, char?.exaustao);
  const caracs = caracteristicasPorFaixa();

  // Magias: preparadas e conhecidas entram juntas (truques moram em
  // magias_conhecidas com circulo 0); magiasPorFaixaDeAcao deduplica.
  const magias = magiasPorFaixaDeAcao(
    [...(char?.magias_preparadas || []), ...(char?.magias_conhecidas || [])],
    _indiceMagias?.magias || []
  );

  // Espaços lidos UMA vez por abertura do painel: cada card de magia e a
  // ação "Usar Magia" do livro perguntam a partir desta mesma lista, em vez
  // de remontar as reservas por card.
  const reservas = reservasDeEspacos();
  // Motivo de "Usar Magia" estar fora: sem magia nenhuma na ficha, ou sem
  // espaço para as que existem. '' quando há o que conjurar.
  const semConjuracao = motivoSemConjuracao(magias, reservas);

  // Cada chave do mapa guarda o que o popup precisa para confirmar: a
  // faixa que sera marcada e, quando houver, o custo proprio da opcao
  // (`magia` gasta espaco, `carac` gasta uso).
  const registrar = (chave, dados) => { _detalhes.set(chave, dados); };

  // --- Ação ---
  const itensAcao = [];
  const ataques = getAtaquesPorAcao();
  itensAcao.push(cardOpcao('Atacar', ataques > 1 ? `${ataques} ataques por Ação` : 'Arma ou Ataque Desarmado', 'livro:Atacar'));
  registrar('livro:Atacar', { titulo: 'Atacar', texto: 'Atacar com uma arma ou um Ataque Desarmado.', faixa: 'acao' });

  for (const c of caracs.acao) {
    const chave = `carac:${c.nome}`;
    itensAcao.push(cardOpcao(c.nome, c.origem, chave));
    registrar(chave, { titulo: c.nome, texto: c.descricao, faixa: 'acao', carac: c });
  }
  for (const m of magias.acao) {
    const chave = `magia:${m.nome}`;
    const conjuravel = magiaConjuravel(m, reservas);
    itensAcao.push(cardOpcao(m.nome, subtituloMagia(m, conjuravel), chave, { desabilitado: !conjuravel }));
    registrar(chave, { titulo: m.nome, texto: `Tempo de conjuração: ${m.tempo}`, faixa: 'acao', magia: m });
  }
  // As acoes genericas do livro fecham a faixa: sao as que o jogador novo
  // mais esquece que existem (Esquivar, Desengajar, Ajudar).
  for (const a of (_acoesLivro || [])) {
    if (a.acao === 'Atacar') continue; // ja entrou acima, com a contagem de ataques
    const chave = `livro:${a.acao}`;
    // "Usar Magia" sai desabilitada quando nao ha o que conjurar -- inclusive
    // para quem nao conjura, que e o caso extremo do mesmo motivo. As outras
    // 11 acoes do livro qualquer personagem executa.
    const bloqueio = a.acao === 'Usar Magia' ? semConjuracao : '';
    itensAcao.push(cardOpcao(a.acao, bloqueio, chave, { desabilitado: !!bloqueio }));
    registrar(chave, { titulo: a.acao, texto: a.resumo, faixa: 'acao' });
  }

  // --- Ação Bônus ---
  const itensBonus = [];
  for (const c of caracs.bonus) {
    const chave = `carac:${c.nome}`;
    itensBonus.push(cardOpcao(c.nome, c.origem, chave));
    registrar(chave, { titulo: c.nome, texto: c.descricao, faixa: 'bonus', carac: c });
  }
  for (const m of magias.bonus) {
    const chave = `magia:${m.nome}`;
    const conjuravel = magiaConjuravel(m, reservas);
    itensBonus.push(cardOpcao(m.nome, subtituloMagia(m, conjuravel), chave, { desabilitado: !conjuravel }));
    registrar(chave, { titulo: m.nome, texto: `Tempo de conjuração: ${m.tempo}`, faixa: 'bonus', magia: m });
  }

  // --- Reação ---
  const itensReacao = [];
  itensReacao.push(cardOpcao('Ataque de Oportunidade', 'Quando um inimigo sai do seu alcance', 'livro:AO'));
  registrar('livro:AO', {
    titulo: 'Ataque de Oportunidade',
    texto: 'Quando uma criatura que você pode ver sai do seu alcance corpo a corpo, você pode gastar sua Reação para realizar um único ataque corpo a corpo contra ela.',
    faixa: 'reacao',
  });
  for (const c of caracs.reacao) {
    const chave = `carac:${c.nome}`;
    itensReacao.push(cardOpcao(c.nome, c.origem, chave));
    registrar(chave, { titulo: c.nome, texto: c.descricao, faixa: 'reacao', carac: c });
  }
  for (const m of magias.reacao) {
    const chave = `magia:${m.nome}`;
    const conjuravel = magiaConjuravel(m, reservas);
    itensReacao.push(cardOpcao(m.nome, subtituloMagia(m, conjuravel), chave, { desabilitado: !conjuravel }));
    registrar(chave, { titulo: m.nome, texto: `Tempo de conjuração: ${m.tempo}`, faixa: 'reacao', magia: m });
  }

  // --- Movimento e grátis ---
  const espData = especiesCache?.especies?.find((e) => e.nome === char?.especie);
  const deslBase = espData ? getDeslocamento(espData.texto_completo) : '9 metros';
  const desl = deslocamentoComQuadrados(getDeslocamentoFinal(deslBase));
  const itensLivres = [
    cardOpcao('Mover', desl, 'livro:Mover'),
    cardOpcao('Interagir com 1 objeto', 'Sacar arma, abrir porta, pegar item', 'livro:Objeto'),
    cardOpcao('Falar', 'Algumas frases curtas', 'livro:Falar'),
  ];
  registrar('livro:Mover', { titulo: 'Movimento', texto: `Você pode mover até ${desl} no seu turno, e pode quebrar esse movimento antes e depois da sua Ação.`, faixa: 'livre' });
  registrar('livro:Objeto', { titulo: 'Interação com objeto', texto: 'Uma interação gratuita com um objeto por turno: sacar ou guardar uma arma, abrir uma porta, pegar um item no chão. A segunda interação no mesmo turno custa a ação Usar Objeto.', faixa: 'livre' });
  registrar('livro:Falar', { titulo: 'Falar', texto: 'Falar algumas frases curtas é de graça no seu turno.', faixa: 'livre' });

  const limiteMovimento = limites.movimento;

  return `
    <div class="painel-turno">
      <div class="painel-turno-topo">
        <p class="painel-turno-resumo">Toque no que você vai fazer: o app mostra a regra, pede confirmação e desconta o custo. No seu turno: <strong>1 Ação</strong> + <strong>1 Movimento</strong>${itensBonus.length ? ' + <strong>1 Ação Bônus</strong>' : ''}. A <strong>Reação</strong> é 1 por rodada, mesmo fora do seu turno.</p>
        <button class="btn btn-sm btn-primary" id="btn-passar-turno">↻ Novo turno</button>
      </div>

      ${limites.motivos.length ? `
        <div class="painel-turno-condicoes">
          <strong>Condições ativas limitam seu turno:</strong>
          <ul>${limites.motivos.map((m) => `<li>${escHtml(m)}</li>`).join('')}</ul>
        </div>` : ''}

      ${secaoFaixa({
        id: 'acao', titulo: 'Ação', icone: '⚔️', itens: itensAcao,
        gasta: turno.acao_usada, bloqueada: limites.acao, motivo: '',
      })}

      ${secaoFaixa({
        id: 'bonus', titulo: 'Ação Bônus', icone: '⚡', itens: itensBonus,
        gasta: turno.bonus_usada, bloqueada: limites.bonus,
        motivo: itensBonus.length ? '' : 'Ação Bônus só existe quando uma característica, magia ou item sua concede uma.',
      })}

      ${secaoFaixa({
        id: 'reacao', titulo: 'Reação', icone: '🛡️', itens: itensReacao,
        gasta: turno.reacao_usada, bloqueada: limites.reacao, motivo: '',
      })}

      ${secaoFaixa({
        id: 'livre', titulo: 'Movimento e grátis', icone: '👣', itens: itensLivres,
        gasta: false, bloqueada: limiteMovimento,
        motivo: limiteMovimento ? 'Seu Deslocamento está 0.' : '',
      })}
    </div>
  `;
}

// ---------------- Popup de confirmação ----------------

/**
 * O que a opcao vai custar agora, lido no momento da abertura do popup:
 * a faixa esta bloqueada por condicao? ja foi gasta? ha espaco de magia
 * ou uso de caracteristica sobrando?
 *
 * @param {object} d Entrada de `_detalhes`.
 * @returns {{bloqueada:boolean, gasta:boolean, espacos:Array, usos:object|null, impedida:boolean, aviso:string}}
 */
function situacaoDaOpcao(d) {
  const turno = estadoTurno();
  const limites = limitesDoTurno(char?.condicoes, char?.exaustao);
  const bloqueada = d.faixa !== 'livre' && !!limites[d.faixa];
  const gasta = d.faixa !== 'livre' && !!turno[CAMPO_DA_FAIXA[d.faixa]];

  // Magia de circulo 1+: precisa de espaco. Truque (circulo 0) nao gasta.
  const espacos = d.magia && d.magia.circulo > 0 ? espacosParaMagia(d.magia.circulo) : [];
  const semEspaco = !!(d.magia && d.magia.circulo > 0 && espacos.length === 0);

  // Caracteristica com contador: dedicado da classe (proprio ou pool), ou
  // o generico de `char.usos_habilidades`. null = nao ha uso a rastrear.
  // O saldo tem de cobrir o CUSTO, que nem sempre e 1 -- Explosao
  // Elemental custa 2 Pontos de Foco, Mao da Misericordia Final custa 5.
  const usos = d.carac ? contagemDeUso(d.carac) : null;
  const semUso = !!(usos && usos.disponiveis < usos.custo);

  let aviso = '';
  if (bloqueada) aviso = `Suas condições atuais bloqueiam a ${NOME_DA_FAIXA[d.faixa]}.`;
  else if (semEspaco) aviso = `Você não tem espaço de ${d.magia.circulo}º círculo ou maior disponível.`;
  else if (semUso) {
    aviso = usos.custo > 1
      ? `${d.titulo} custa ${usos.custo} ${usos.rotulo} e você tem ${usos.disponiveis}. Descanse para recuperar.`
      : `Sem ${usos.rotulo} disponível para ${d.titulo}. Descanse para recuperar.`;
  }

  return { bloqueada, gasta, espacos, usos, impedida: bloqueada || semEspaco || semUso, aviso };
}

/** Chip de uma reserva de espaco de magia; o primeiro nasce selecionado. */
function chipEspaco(r, selecionado) {
  const rotulo = `${r.circulo}º círculo${r.fonte === 'pacto' ? ' (Pacto)' : ''}`;
  return `
    <button class="acao-espaco-chip ${selecionado ? 'acao-espaco-chip-sel' : ''}" data-acao-espaco="${escHtml(`${r.fonte}|${r.circulo}`)}">
      ${escHtml(rotulo)} <span class="acao-espaco-saldo">${r.disponiveis} livre${r.disponiveis > 1 ? 's' : ''}</span>
    </button>`;
}

/** Corpo do popup: descricao do livro + o que a confirmacao vai gastar. */
function corpoDoPopup(d, sit) {
  const linhas = [];

  if (d.faixa === 'livre') {
    linhas.push('<p class="acao-pop-custo acao-pop-custo-livre">Grátis: não gasta nada do seu turno.</p>');
  } else {
    const custos = [`gasta sua <strong>${NOME_DA_FAIXA[d.faixa]}</strong>`];
    if (d.magia && d.magia.circulo > 0) custos.push('gasta <strong>1 espaço de magia</strong>');
    // "voce tem X de Y" e nao "restam X": o numero e o saldo de AGORA, lido
    // antes de gastar -- escrever "restam" faria o popup prometer o saldo
    // de depois e errar por um. O rotulo vem do contador (uso, Ponto de
    // Foco, uso de Canalizar Divindade...), para o popup falar a mesma
    // lingua do chip da ficha.
    if (sit.usos) {
      custos.push(`gasta <strong>${sit.usos.custo} ${escHtml(sit.usos.rotulo)}</strong> (você tem ${sit.usos.disponiveis} de ${sit.usos.max})`);
    }
    linhas.push(`<p class="acao-pop-custo">Confirmar ${custos.join(', ')}.</p>`);
  }

  if (sit.aviso) linhas.push(`<p class="acao-pop-aviso">${escHtml(sit.aviso)}</p>`);
  else if (sit.gasta) linhas.push(`<p class="acao-pop-aviso acao-pop-aviso-leve">Sua ${NOME_DA_FAIXA[d.faixa]} já foi usada neste turno. Confirme só se alguma regra lhe deu outra (ex.: Surto de Ação).</p>`);

  if (sit.espacos.length > 0) {
    linhas.push(`
      <div class="acao-espacos">
        <span class="acao-espacos-rotulo">De qual espaço?</span>
        <div class="acao-espacos-chips">${sit.espacos.map((r, i) => chipEspaco(r, i === 0)).join('')}</div>
      </div>`);
  }

  linhas.push(`<div class="acao-pop-texto">${escHtml(d.texto || '')}</div>`);
  return linhas.join('');
}

/**
 * Abre o popup de uma opcao: descricao do livro, o que vai ser gasto e o
 * botao de confirmar. Sub-modal por cima do painel (abrirModal empilha
 * sozinho quando ja ha modal aberto). Regra do CLAUDE.md: descricao nao
 * expande dentro do card, vai para popup.
 */
function abrirPopupOpcao(chave) {
  const d = _detalhes.get(chave);
  if (!d) return;
  const sit = situacaoDaOpcao(d);
  _opcaoAberta = { ...d, chave, espaco: sit.espacos[0] || null };

  // Sem confirmacao quando a opcao e gratis (nao ha o que gastar) ou
  // impedida (condicao, espaco ou uso): o popup vira so a referencia.
  const podeConfirmar = d.faixa !== 'livre' && !sit.impedida;
  const rotulo = sit.gasta ? 'Usar mesmo assim' : 'Usar';
  const acoes = `
    ${podeConfirmar ? `<button class="btn btn-accent" data-acao-confirmar="sim">${rotulo}</button>` : ''}
    <button class="btn btn-secondary" onclick="fecharModal()">${podeConfirmar ? 'Cancelar' : 'Fechar'}</button>`;

  abrirModal(d.titulo, corpoDoPopup(d, sit), acoes);
  ligarEventosDoPopup();
}

/** Liga os cliques do popup recem-aberto (o sub-modal mais recente). */
function ligarEventosDoPopup() {
  const sub = document.querySelectorAll('.sub-modal-overlay');
  const atual = sub[sub.length - 1];
  if (!atual) return;

  atual.querySelectorAll('[data-acao-espaco]').forEach((el) => {
    el.addEventListener('click', () => {
      const [fonte, circulo] = String(el.dataset.acaoEspaco).split('|');
      _opcaoAberta = { ..._opcaoAberta, espaco: { fonte, circulo: Number(circulo) } };
      atual.querySelectorAll('[data-acao-espaco]').forEach((b) => b.classList.remove('acao-espaco-chip-sel'));
      el.classList.add('acao-espaco-chip-sel');
    });
  });

  atual.querySelector('[data-acao-confirmar]')?.addEventListener('click', confirmarOpcaoAberta);
}

/**
 * Confirma a opcao aberta: desconta o custo proprio (espaco de magia ou
 * uso da caracteristica) ANTES de marcar a faixa, para um custo que falha
 * -- espaco que acabou noutra aba, uso ja gasto pelo chip da ficha --
 * nao deixar a faixa marcada sem nada ter sido usado.
 */
function confirmarOpcaoAberta() {
  const d = _opcaoAberta;
  if (!d || d.faixa === 'livre') return;
  const mensagens = [];

  if (d.magia && d.magia.circulo > 0) {
    if (!d.espaco) { toast('Escolha de qual espaço gastar.', 'error'); return; }
    if (!consumirEspacoDeMagia(d.espaco.fonte, d.espaco.circulo)) {
      toast('Esse espaço não está mais disponível.', 'error');
      return;
    }
    mensagens.push(`${d.titulo} conjurada (espaço de ${d.espaco.circulo}º círculo).`);
  } else if (d.carac) {
    const r = consumirUso(d.carac);
    if (!r.ok) { toast(r.mensagem, 'error'); return; }
    if (r.mensagem) mensagens.push(r.mensagem);
  }

  salvarTurno({ [CAMPO_DA_FAIXA[d.faixa]]: true });
  _opcaoAberta = null;
  fecharModalTodos();
  toast(mensagens[0] || `${d.titulo}: ${NOME_DA_FAIXA[d.faixa]} marcada como usada.`, 'success');
  renderFichaCompleta();
  abrirPainel();
}

/** Abre (ou reabre, apos uma confirmacao) o painel do turno. */
async function abrirPainel() {
  // Carga sob demanda: quem nunca abre o painel nao paga o download.
  if (!_acoesLivro) _acoesLivro = await getAcoesDoLivro();
  if (!_indiceMagias) _indiceMagias = await getIndiceMagias();

  abrirModal('Meu Turno', corpoDoPainel(),
    '<button class="btn btn-secondary" onclick="fecharModal()">Fechar</button>');
  ligarEventosDoPainel();
}

/** Liga os cliques de dentro do painel (re-registrados a cada reabertura). */
function ligarEventosDoPainel() {
  document.querySelectorAll('[data-acao-detalhe]').forEach((el) => {
    el.addEventListener('click', () => abrirPopupOpcao(el.dataset.acaoDetalhe));
  });

  document.getElementById('btn-passar-turno')?.addEventListener('click', () => {
    // Novo turno devolve as tres faixas: a Reacao recarrega no INICIO do
    // seu turno pela regra, e e justamente o recurso que o jogador mais
    // esquece de ter gastado fora do proprio turno. Nao mexe em espaco de
    // magia nem em uso de caracteristica: esses voltam em descanso, nao
    // em turno novo.
    salvarTurno(turnoZerado());
    window.fecharModal();
    renderFichaCompleta();
    abrirPainel();
  });

  document.querySelectorAll('[data-devolver-faixa]').forEach((el) => {
    el.addEventListener('click', () => {
      const campo = CAMPO_DA_FAIXA[el.dataset.devolverFaixa];
      if (!campo) return;
      // Desfaz so a marca da faixa -- o espaco de magia ou o uso gasto na
      // confirmacao nao volta por aqui: quem devolve espaco e a caixa de
      // espacos do card Magias, e uso, o chip do recurso. Desfazer os dois
      // daqui exigiria lembrar QUAL opcao marcou a faixa, e um "devolver"
      // que adivinha errado devolveria recurso que o jogador gastou.
      salvarTurno({ [campo]: false });
      window.fecharModal();
      renderFichaCompleta();
      abrirPainel();
    });
  });
}

/** Liga o botao flutuante. Chamada no setup geral da ficha (ficha.js). */
export function setupEventosAcoesTurno() {
  document.getElementById('fab-toggle-acoes')?.addEventListener('click', () => {
    abrirPainel();
  });
}
