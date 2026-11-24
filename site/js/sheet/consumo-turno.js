// ============================================================
// Consumo de recursos a partir do painel "Meu Turno".
//
// Confirmar uma opcao no painel nao marca so a faixa (Acao/Bonus/Reacao):
// a opcao tem um custo proprio -- o espaco de magia, ou o uso da
// caracteristica -- e este modulo e o adaptador que responde "quanto
// resta disso?" e "gaste um".
//
// Ele le e escreve os MESMOS campos que os chips de recurso da ficha
// (char.recursos.<classe>.*) e que o card de Caracteristicas
// (char.usos_habilidades), nunca um contador proprio: duas fontes de
// verdade para o mesmo uso deixam uma permitir o que a outra ja negou --
// o bug que regras-usos-gratis-magia.js registra e que esta aqui para
// nao se repetir.
//
// DUAS FORMAS DE CUSTO, porque o livro tem as duas:
//  - contador PROPRIO: a caracteristica tem a propria reserva de usos
//    (Furia, Recuperar Folego, Labareda Protetora...);
//  - POOL compartilhado: varias caracteristicas gastam do MESMO contador,
//    e cada uma com o seu preco (Pontos de Foco do Monge, usos de
//    Canalizar Divindade, Dados de Energia Psionica). Sem isso, Explosao
//    Elemental (2 Pontos de Foco) e Mao de Cura (1) teriam de inventar
//    contadores proprios e o total do Monge nunca fecharia.
//
// O que NAO entra aqui: caracteristica cujo custo o livro deixa OPCIONAL
// ou condicional (Defletir Ataques so gasta 1 Ponto de Foco se voce
// redirecionar; Laminas da Alma so gasta o dado se o ataque acertar). O
// painel nao tem como saber o que aconteceu na mesa, e cobrar sempre
// tiraria recurso que a regra nao tirou -- essas caem no contador
// generico ou marcam so a faixa.
//
// Le `char` de estado.js em vez de receber o personagem por parametro,
// pelo mesmo motivo de regras-usos-gratis-magia.js: os
// getEstadoRecursos<Classe>() que ele consulta ja leem esse mesmo `char`,
// e um parametro proprio aqui divergiria da fonte real sem ganhar nada.
// ============================================================
import { bonusProficiencia, detectarRecarga } from '../utils.js';
import { escolhasDeEspaco } from '../regras-acoes-turno.js';
import { nivelNa, temClasse } from '../regras-multiclasse.js';
import { char } from './estado.js';
import { detectarUsosMaximos, lerUsoHabilidade } from './habilidades.js';
import { gastarEspaco, reservasDeEspacos } from './reservas-espacos.js';
import { getEstadoFuria } from './classes/barbaro.js';
import { getEstadoInspiracaoBardo } from './classes/bardo.js';
import { getEstadoRecursosClerigo, getEstadoSubclassesClerigo } from './classes/clerigo.js';
import { getEstadoRecursosGuardiao } from './classes/guardiao.js';
import { getEstadoRecursosGuerreiro } from './classes/guerreiro.js';
import { getEstadoRecursosLadino } from './classes/ladino.js';
import { getEstadoRecursosMonge } from './classes/monge.js';
import { getEstadoRecursosPaladino } from './classes/paladino.js';

/** Estado de uma classe so quando o personagem TEM a classe -- os
 *  getEstadoRecursos<Classe>() inicializam `char.recursos` para quem
 *  chama, e chama-los sem a classe carimbaria recurso de classe que o
 *  personagem nao tem. */
const seTem = (classe, getter) => (temClasse(char, classe) ? getter() : null);

// ---------------- Pools compartilhados ----------------

/**
 * Contadores que MAIS DE UMA caracteristica gasta. `contagem` devolve o
 * saldo do pool inteiro; `gastar(n)` desconta `n` de uma vez, porque o
 * preco varia por caracteristica (Explosao Elemental custa 2 Pontos de
 * Foco, Mao da Misericordia Final custa 5).
 */
const POOLS = {
  focoMonge: {
    singular: 'Ponto de Foco', plural: 'Pontos de Foco',
    contagem: () => {
      const e = seTem('Monge', getEstadoRecursosMonge);
      return e ? { max: e.pontosMax, disponiveis: e.pontosAtuais } : null;
    },
    gastar: (n) => { char.recursos.monge.pontos_foco_gastos += n; },
  },
  canalizarClerigo: {
    singular: 'uso de Canalizar Divindade', plural: 'usos de Canalizar Divindade',
    contagem: () => {
      const e = seTem('Clérigo', getEstadoRecursosClerigo);
      return e ? { max: e.canalizarDivindadeMax, disponiveis: e.canalizarDivindadeUsosDisponiveis } : null;
    },
    gastar: (n) => { char.recursos.clerigo.canalizar_divindade_usos_gastos += n; },
  },
  canalizarPaladino: {
    singular: 'uso de Canalizar Divindade', plural: 'usos de Canalizar Divindade',
    contagem: () => {
      const e = seTem('Paladino', getEstadoRecursosPaladino);
      return e ? { max: e.canalizarMax, disponiveis: e.canalizarDisponiveis } : null;
    },
    gastar: (n) => { char.recursos.paladino.canalizar_divindade_usos_gastos += n; },
  },
  psionicosGuerreiro: {
    singular: 'Dado de Energia Psiônica', plural: 'Dados de Energia Psiônica',
    contagem: () => {
      const e = seTem('Guerreiro', getEstadoRecursosGuerreiro);
      return e?.ehCombatentePsiquico
        ? { max: e.dadosPsionicosMaxG, disponiveis: e.dadosPsionicosDisponiveisG } : null;
    },
    gastar: (n) => { char.recursos.guerreiro.subclasses.combatente_psiquico.dados_psionicos_gastos += n; },
  },
  superioridadeGuerreiro: {
    singular: 'Dado de Superioridade', plural: 'Dados de Superioridade',
    contagem: () => {
      const e = seTem('Guerreiro', getEstadoRecursosGuerreiro);
      return e?.ehMestreBatalha
        ? { max: e.dadosSuperioridadeMax, disponiveis: e.dadosSuperioridadeDisponiveis } : null;
    },
    gastar: (n) => { char.recursos.guerreiro.subclasses.mestre_batalha.dados_superioridade_gastos += n; },
  },
};

// ---------------- Fabricas de entrada ----------------

/** Entrada de contador NUMERICO proprio: `ler()` devolve {max, disponiveis}. */
function proprio(nome, classe, ler, gastar, mensagem) {
  return { nome, classe, contagem: ler, consumir: () => gastar(), mensagem };
}

/** Entrada de contador BOOLEANO proprio (1 uso ate o descanso):
 *  `lerUsado()` devolve true/false/null (null = nao se aplica). */
function booleano(nome, classe, lerUsado, marcar, mensagem) {
  return {
    nome, classe,
    contagem: () => {
      const usado = lerUsado();
      return usado === null || usado === undefined ? null : { max: 1, disponiveis: usado ? 0 : 1 };
    },
    consumir: () => marcar(),
    mensagem,
  };
}

/** Entrada que gasta `custo` de um POOL compartilhado. */
function doPool(nome, classe, pool, custo) {
  return { nome, classe, pool, custo };
}

/**
 * Cada caracteristica do painel que tem contador na ficha. `classe`
 * desempata nome repetido: "Canalizar Divindade" e "Poder Psionico"
 * existem em duas classes, com contadores separados, e num personagem
 * multiclasse gastar o errado tiraria um uso que o livro nao tirou.
 *
 * O preco de cada uma veio do texto do livro em `dados/` -- a frase que
 * diz "gasta X" --, nao de memoria.
 */
const RECURSOS_DEDICADOS = [
  // ---------- Bárbaro ----------
  proprio('Fúria', 'Bárbaro',
    () => { const e = seTem('Bárbaro', getEstadoFuria); return e ? { max: e.usosMax, disponiveis: e.usosDisponiveis } : null; },
    () => { char.recursos.furia_usos_gastos += 1; }),

  // ---------- Bardo ----------
  proprio('Inspiração de Bardo', 'Bardo',
    () => { const e = seTem('Bardo', getEstadoInspiracaoBardo); return e ? { max: e.usosMax, disponiveis: e.usosDisponiveis } : null; },
    () => { char.recursos.inspiracao_bardo_usos_gastos += 1; }),

  // ---------- Clérigo ----------
  // Canalizar Divindade é o POOL: a característica em si gasta 1 uso dele.
  doPool('Canalizar Divindade', 'Clérigo', 'canalizarClerigo', 1),
  // "você pode gastar um uso de seu Canalizar Divindade" (Ataque Direcionado),
  // "gasta o uso de seu Canalizar Divindade" (Brilho do Amanhecer),
  // "gastar um uso de seu Canalizar Divindade" (Invocar Duplicidade),
  // "usa seu Canalizar Divindade" (Preservar a Vida).
  doPool('Ataque Direcionado', 'Clérigo', 'canalizarClerigo', 1),
  doPool('Brilho do Amanhecer', 'Clérigo', 'canalizarClerigo', 1),
  doPool('Invocar Duplicidade', 'Clérigo', 'canalizarClerigo', 1),
  doPool('Preservar a Vida', 'Clérigo', 'canalizarClerigo', 1),
  // Contadores próprios (modificador de Sabedoria em usos).
  proprio('Sacerdote da Guerra', 'Clérigo',
    () => { const s = seTem('Clérigo', getEstadoSubclassesClerigo)?.guerra; return s ? { max: s.sacerdoteUsosMax, disponiveis: s.sacerdoteUsosDisponiveis } : null; },
    () => { char.recursos.clerigo.subclasses.guerra.sacerdote_guerra_usos_gastos += 1; }),
  proprio('Labareda Protetora', 'Clérigo',
    () => { const s = seTem('Clérigo', getEstadoSubclassesClerigo)?.luz; return s ? { max: s.labaredaUsosMax, disponiveis: s.labaredaUsosDisponiveis } : null; },
    () => { char.recursos.clerigo.subclasses.luz.labareda_protetora_usos_gastos += 1; }),
  proprio('Coroa de Luz', 'Clérigo',
    () => { const s = seTem('Clérigo', getEstadoSubclassesClerigo)?.luz; return s ? { max: s.coroaUsosMax, disponiveis: s.coroaUsosDisponiveis } : null; },
    () => { char.recursos.clerigo.subclasses.luz.coroa_luz_usos_gastos += 1; }),

  // ---------- Guerreiro ----------
  proprio('Recuperar Fôlego', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e ? { max: e.recuperarFolegoMax, disponiveis: e.recuperarFolegoDisponiveis } : null; },
    () => { char.recursos.guerreiro.recuperar_folego_usos_gastos += 1; },
    // "1d10 mais seu nivel DE GUERREIRO" (Classes.md:3822) -- o mesmo texto
    // do botao do chip, para as duas vias dizerem a mesma coisa.
    () => `Recuperar Fôlego usado! Role 1d10 + ${nivelNa(char, 'Guerreiro')} e aplique a cura.`),
  proprio('Surto de Ação', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e ? { max: e.surtoMax, disponiveis: e.surtoDisponiveis } : null; },
    () => { char.recursos.guerreiro.surto_acao_usos_gastos += 1; },
    () => 'Surto de Ação usado! Você tem 1 ação adicional (exceto Usar Magia).'),
  proprio('Indomável', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e?.indomavelMax > 0 ? { max: e.indomavelMax, disponiveis: e.indomavelDisponiveis } : null; },
    () => { char.recursos.guerreiro.indomavel_usos_gastos += 1; },
    () => `Indomável usado! Rejogue a salvaguarda com bônus de +${nivelNa(char, 'Guerreiro')}.`),
  // Mestre da Batalha.
  booleano('Conheça Seu Inimigo', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e?.conhecaInimigoAtivo ? e.conhecaInimigoUsado : null; },
    () => { char.recursos.guerreiro.subclasses.mestre_batalha.conheca_inimigo_usado = true; }),
  // Combatente Psíquico: "a menos que gaste um Dado de Energia Psiônica
  // para recuperar seu uso" -- o uso em si é 1 por descanso, booleano.
  booleano('Adepto Telecinético', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e?.adeptoTelecineticoAtivo ? e.saltoImpulsaoUsado : null; },
    () => { char.recursos.guerreiro.subclasses.combatente_psiquico.salto_impulsao_usado = true; }),
  booleano('Baluarte de Energia', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e?.baluarteEnergiaAtivo ? e.baluarteUsado : null; },
    () => { char.recursos.guerreiro.subclasses.combatente_psiquico.baluarte_usado = true; }),
  booleano('Mestre Telecinético', 'Guerreiro',
    () => { const e = seTem('Guerreiro', getEstadoRecursosGuerreiro); return e?.mestreTelecineticoAtivo ? e.mestreTelecineticoUsado : null; },
    () => { char.recursos.guerreiro.subclasses.combatente_psiquico.mestre_telecinetico_usado = true; }),
  // "você pode gastar um Dado de Energia Psiônica ... e encerrar todos os
  // efeitos em você que lhe deram Amedrontado ou Enfeitiçado".
  doPool('Resguardo Mental', 'Guerreiro', 'psionicosGuerreiro', 1),

  // ---------- Ladino ----------
  booleano('Golpe de Sorte', 'Ladino',
    () => { const e = seTem('Ladino', getEstadoRecursosLadino); return e?.golpeSorteAtivo ? e.golpeSorteUsado : null; },
    () => { char.recursos.ladino.golpe_sorte_usado = true; },
    () => 'Golpe de Sorte usado! O resultado do Teste de D20 se torna 20.'),
  booleano('Véu Psíquico', 'Ladino',
    () => { const e = seTem('Ladino', getEstadoRecursosLadino); return e?.veuPsiquicoAtivo ? e.veuPsiquicoUsado : null; },
    () => { char.recursos.ladino.subclasses.adaga_espiritual.veu_psiquico_usado = true; }),
  booleano('Rasgar Mente', 'Ladino',
    () => { const e = seTem('Ladino', getEstadoRecursosLadino); return e?.rasgarMenteAtivo ? e.rasgarMenteUsado : null; },
    () => { char.recursos.ladino.subclasses.adaga_espiritual.rasgar_mente_usado = true; }),

  // ---------- Monge ----------
  // Pontos de Foco: Rajada de Golpes, Defesa Paciente e Passo do Vento
  // custam 1 cada, e são as três opções de Foco do Monge.
  doPool('Foco do Monge', 'Monge', 'focoMonge', 1),
  doPool('Mão de Cura', 'Monge', 'focoMonge', 1),              // "gastar 1 Ponto de Foco"
  doPool('Passo da Sombra Aprimorado', 'Monge', 'focoMonge', 1), // "gastar 1 Ponto de Foco"
  doPool('Explosão Elemental', 'Monge', 'focoMonge', 2),        // "gastar 2 Pontos de Foco"
  doPool('Manto da Sombra', 'Monge', 'focoMonge', 3),           // "gastar 3 Pontos de Foco"
  doPool('Palma Vibrante', 'Monge', 'focoMonge', 4),            // "gastar 4 Pontos de Foco"
  doPool('Mão da Misericórdia Final', 'Monge', 'focoMonge', 5), // "gastar 5 Pontos de Foco"
  proprio('Integridade Corporal', 'Monge',
    () => { const e = seTem('Monge', getEstadoRecursosMonge); return e?.integridadeAtiva ? { max: e.integridadeMax, disponiveis: e.integridadeDisponiveis } : null; },
    () => { char.recursos.monge.subclasses.mao_espalmada.integridade_usos_gastos += 1; }),
  booleano('Metabolismo Incomum', 'Monge',
    () => { const e = seTem('Monge', getEstadoRecursosMonge); return typeof e?.metabolismoUsado === 'boolean' ? e.metabolismoUsado : null; },
    () => { char.recursos.monge.metabolismo_usado = true; }),

  // ---------- Paladino ----------
  doPool('Canalizar Divindade', 'Paladino', 'canalizarPaladino', 1),
  // "gastar um uso de seu Canalizar Divindade" em todas as quatro.
  doPool('Repudiar Inimigos', 'Paladino', 'canalizarPaladino', 1),
  doPool('Arma Sagrada', 'Paladino', 'canalizarPaladino', 1),
  doPool('Atleta Inigualável', 'Paladino', 'canalizarPaladino', 1),
  doPool('Voto de Inimizade', 'Paladino', 'canalizarPaladino', 1),
  doPool('A Ira da Natureza', 'Paladino', 'canalizarPaladino', 1),

  // ---------- Guardião ----------
  proprio('Incansável', 'Guardião',
    () => { const e = seTem('Guardião', getEstadoRecursosGuardiao); return e?.incansavelMax > 0 ? { max: e.incansavelMax, disponiveis: e.incansavelDisponiveis } : null; },
    () => { char.recursos.guardiao.incansavel_usos_gastos += 1; }),
  proprio('Véu da Natureza', 'Guardião',
    () => { const e = seTem('Guardião', getEstadoRecursosGuardiao); return e?.veuNaturezaMax > 0 ? { max: e.veuNaturezaMax, disponiveis: e.veuNaturezaDisponiveis } : null; },
    () => { char.recursos.guardiao.veu_natureza_usos_gastos += 1; }),
];

/**
 * A entrada cadastrada para uma caracteristica, so quando ela se aplica a
 * ESTE personagem. Devolve a entrada JA RESOLVIDA, com a contagem e o
 * preco prontos -- quem chama nao precisa saber se o custo vem de pool ou
 * de contador proprio.
 *
 * @returns {{contagem:{max:number,disponiveis:number}, custo:number,
 *   rotulo:string, consumir:Function, mensagem:Function|undefined}|null}
 */
function dedicadoDe(nome, classe, manobra = false) {
  if (manobra && classe === 'Guerreiro') {
    const pool = POOLS.superioridadeGuerreiro;
    const c = pool.contagem();
    return c ? { contagem: c, custo: 1, rotulo: pool.singular, consumir: () => pool.gastar(1) } : null;
  }
  if (!nome || !classe) return null;
  const def = RECURSOS_DEDICADOS.find((r) => r.nome === nome && r.classe === classe);
  if (!def) return null;

  if (def.pool) {
    const pool = POOLS[def.pool];
    const c = pool?.contagem();
    if (!c) return null;
    const custo = def.custo;
    return {
      contagem: c, custo,
      rotulo: custo === 1 ? pool.singular : pool.plural,
      consumir: () => pool.gastar(custo),
      mensagem: def.mensagem,
    };
  }

  const c = def.contagem();
  if (!c) return null;
  return {
    contagem: c, custo: 1,
    rotulo: 'uso',
    consumir: def.consumir,
    mensagem: def.mensagem,
  };
}

/**
 * Quanto resta de uma caracteristica e quanto ela custa, pelo contador que
 * a ficha ja usa para ela.
 *
 * @param {{nome:string, classe?:string, fonteUso?:string, descricao?:string}} carac
 * @returns {{max:number, disponiveis:number, custo:number, rotulo:string,
 *   dedicado:boolean}|null} null quando a caracteristica nao tem contador
 *   nenhum -- caso em que usa-la nao gasta nada alem da faixa do turno.
 */
export function contagemDeUso(carac) {
  const def = dedicadoDe(carac?.nome, carac?.classe, carac?.manobra);
  if (def) {
    return {
      max: def.contagem.max, disponiveis: def.contagem.disponiveis,
      custo: def.custo, rotulo: def.rotulo, dedicado: true,
    };
  }

  const { max, temMultiplosUsos, recarga } = contadorGenerico(carac);
  if (!recarga) return null; // sem recarga nao ha uso a contar: e passiva ou ilimitada
  const key = chaveGenerica(carac);
  const { usosAtual, usado } = lerUsoHabilidade(key, max, temMultiplosUsos);
  const base = { custo: 1, rotulo: 'uso', dedicado: false };
  return temMultiplosUsos
    ? { max, disponiveis: Math.max(0, max - usosAtual), ...base }
    : { max: 1, disponiveis: usado ? 0 : 1, ...base };
}

/** Chave da caracteristica em `char.usos_habilidades`, a MESMA que o card
 *  de Caracteristicas (`${fonte}_${nome}`) escreve -- marcar pelo painel e
 *  marcar pelo card tem de ser o mesmo estado. */
function chaveGenerica(carac) {
  return `${carac?.fonteUso || 'classe'}_${carac?.nome || ''}`;
}

/**
 * Maximo de usos e forma do contador generico de uma caracteristica, pela
 * prosa da descricao -- a mesma deteccao de sheet/habilidades.js (classe e
 * subclasse) e sheet/caracteristicas.js (especie, onde "usos iguais ao seu
 * bonus de proficiencia" nao vem escrito com numero).
 */
function contadorGenerico(carac) {
  const descricao = carac?.descricao || '';
  const recarga = detectarRecarga(descricao);
  let max = detectarUsosMaximos(descricao);
  if (carac?.fonteUso === 'especie' && !max && recarga) max = bonusProficiencia(char?.nivel || 1);
  const temMultiplosUsos = !!(max && max > 1 && recarga);
  return { max: max || 1, temMultiplosUsos, recarga };
}

/**
 * Gasta o custo da caracteristica. Nao salva nem re-renderiza: quem chama
 * (o painel) ja faz as duas coisas uma vez so, depois de gastar tudo o
 * que a confirmacao custa.
 *
 * @param {{nome:string, classe?:string, fonteUso?:string, descricao?:string}} carac
 * @returns {{ok:boolean, esgotado:boolean, semContador:boolean, mensagem:string}}
 *   `semContador` e sucesso: a caracteristica nao tem uso a rastrear (ex.:
 *   Ataque Extra), entao confirmar marca so a faixa do turno.
 */
export function consumirUso(carac) {
  const def = dedicadoDe(carac?.nome, carac?.classe, carac?.manobra);
  if (def) {
    if (def.contagem.disponiveis < def.custo) {
      return { ok: false, esgotado: true, semContador: false, mensagem: `Sem ${def.rotulo} suficiente para ${carac.nome}.` };
    }
    def.consumir();
    return { ok: true, esgotado: false, semContador: false, mensagem: def.mensagem ? def.mensagem() : '' };
  }

  const { max, temMultiplosUsos, recarga } = contadorGenerico(carac);
  if (!recarga) return { ok: true, esgotado: false, semContador: true, mensagem: '' };

  const key = chaveGenerica(carac);
  const { usosAtual, usado } = lerUsoHabilidade(key, max, temMultiplosUsos);
  if (!char.usos_habilidades) char.usos_habilidades = {};

  if (temMultiplosUsos) {
    if (usosAtual >= max) {
      return { ok: false, esgotado: true, semContador: false, mensagem: `Sem usos de ${carac.nome} disponíveis.` };
    }
    char.usos_habilidades[key] = usosAtual + 1;
    return { ok: true, esgotado: false, semContador: false, mensagem: '' };
  }

  if (usado) {
    return { ok: false, esgotado: true, semContador: false, mensagem: `${carac.nome} já foi usado. Descanse para recuperar.` };
  }
  char.usos_habilidades[key] = true;
  return { ok: true, esgotado: false, semContador: false, mensagem: '' };
}

/**
 * As reservas que podem pagar uma magia deste circulo, da mais barata para
 * a mais cara. Casca no idioma da ficha de `escolhasDeEspaco`
 * (regras-acoes-turno.js), que e pura.
 * @param {number} circulo Circulo base da magia (0 = truque, sem espaco).
 * @returns {Array<{fonte:string, circulo:number, disponiveis:number}>}
 */
export function espacosParaMagia(circulo) {
  return escolhasDeEspaco(reservasDeEspacos(), circulo);
}

/**
 * Gasta um espaco da reserva escolhida. Delega ao escritor autorizado de
 * `char.espacos_magia` (sheet/reservas-espacos.js); nao salva nem
 * re-renderiza, pelo mesmo motivo de `consumirUso`.
 * @param {'conjuracao'|'pacto'} fonte
 * @param {number} circulo
 * @returns {boolean} false quando a reserva nao existe ou ja esgotou.
 */
export function consumirEspacoDeMagia(fonte, circulo) {
  return gastarEspaco(char, fonte, Number(circulo));
}
