// ============================================================

// Regras de campanha: codigo de convite, papeis e quem pode editar o que.
//
// Modulo PURO: sem DOM, sem `char`, sem Firestore. Recebe os dados ja
// carregados por quem chama (sheet/campanha.js) e devolve a decisao. A
// camada que fala com o Firestore mora em site/js/campanha.js.
//
// As regras aqui sao a MESMA logica que firestore.rules aplica no
// servidor -- de proposito, e nao por acidente. A do servidor e a que
// vale (ninguem contorna); a daqui existe para a tela nao oferecer um
// botao que o servidor vai recusar. Mudou uma, confira a outra.
// ============================================================

// Alfabeto sem 0/O/1/I/L: o codigo e ditado em voz alta na mesa, e esses
// sao os caracteres que as pessoas erram ao transcrever.
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TAMANHO_CODIGO = 6;

/**
 * Gera um codigo de convite.
 *
 * @param {() => number} aleatorio Fonte de aleatoriedade, injetada para o
 *   teste poder fixar a sequencia. O padrao e `Math.random`.
 * @returns {string} Codigo de 6 caracteres do alfabeto sem ambiguidade.
 */
export function gerarCodigoConvite(aleatorio = Math.random) {
  let codigo = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) {
    const idx = Math.floor(aleatorio() * ALFABETO_CODIGO.length) % ALFABETO_CODIGO.length;
    codigo += ALFABETO_CODIGO[idx];
  }
  return codigo;
}

/**
 * Poe o codigo digitado na forma canonica: maiusculas, sem espaco, sem
 * hifen. O jogador recebe "ABC-123" num recado e digita "abc 123" --
 * os tres tem de achar a mesma campanha.
 *
 * @param {string} texto Como o jogador digitou.
 * @returns {string} Codigo canonico, possivelmente invalido.
 */
export function normalizarCodigo(texto) {
  return String(texto || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

// NAO ha "correcao" de caractere confuso aqui de proposito. O alfabeto ja
// exclui 0, O, 1, I e L justamente para esse par nunca ser gerado; se o
// jogador digitou um deles, nao da para saber qual letra ele quis (0 ->
// Q? D?), e adivinhar levaria a OUTRO codigo valido -- entrar na campanha
// errada em silencio e pior do que o app dizer "codigo invalido".

/**
 * O codigo tem a forma certa? Nao diz se a campanha existe -- isso so o
 * Firestore responde.
 * @param {string} texto Codigo ja normalizado ou nao.
 * @returns {boolean}
 */
export function codigoValido(texto) {
  const c = normalizarCodigo(texto);
  if (c.length !== TAMANHO_CODIGO) return false;
  return [...c].every((ch) => ALFABETO_CODIGO.includes(ch));
}

/**
 * Papel do usuario na campanha.
 *
 * O mestre e quem esta em `campanha.mestre_uid` -- nao o que a inscricao
 * dele diz. A inscricao e um documento que o proprio usuario escreve, e
 * confiar nela deixaria qualquer membro se promover editando o proprio
 * documento; firestore.rules faz a mesma leitura, pelo mesmo motivo.
 *
 * @param {{mestre_uid?: string}} campanha
 * @param {Array<{uid: string}>} membros Inscricoes da campanha.
 * @param {string} uid Usuario a classificar.
 * @returns {'mestre'|'jogador'|null} null quando nao participa.
 */
export function papelNaCampanha(campanha, membros, uid) {
  if (!uid || !campanha) return null;
  if (campanha.mestre_uid === uid) return 'mestre';
  const lista = Array.isArray(membros) ? membros : [];
  return lista.some((m) => m?.uid === uid) ? 'jogador' : null;
}

/**
 * Quem pode escrever nesta ficha da campanha: o dono dela e o mestre.
 *
 * @param {{dono_uid?: string}} personagem Ficha da campanha.
 * @param {string} uid Usuario.
 * @param {'mestre'|'jogador'|null} papel Papel dele na campanha.
 * @returns {boolean}
 */
export function podeEditarPersonagem(personagem, uid, papel) {
  if (!personagem || !uid) return false;
  if (papel === 'mestre') return true;
  return personagem.dono_uid === uid;
}

/**
 * Quem pode tirar a ficha da campanha: o dono e o mestre. Mesma regra da
 * edicao, isolada por nome proprio porque e uma pergunta diferente e as
 * duas podem divergir depois.
 */
export function podeRemoverPersonagem(personagem, uid, papel) {
  return podeEditarPersonagem(personagem, uid, papel);
}

/**
 * A ficha, reduzida ao que a tela do mestre mostra numa linha. PURA: nao
 * le `char` nem o DOM, para a tela do mestre poder ser montada a partir
 * de qualquer ficha que chegue do Firestore -- inclusive uma gravada por
 * uma versao mais nova do app, com campos que esta ainda nao conhece.
 *
 * @param {object} p Ficha completa.
 * @returns {{id, nome, dono_uid, classe, nivel, pvAtual, pvMax, ca,
 *   condicoes: string[], atualizado_em: string}}
 */
export function resumoDoPersonagem(p) {
  const classes = Array.isArray(p?.classes) && p.classes.length
    ? p.classes.map((c) => `${c.classe} ${c.nivel}`).join(' / ')
    : [p?.classe, p?.nivel].filter(Boolean).join(' ');
  return {
    id: p?.id || '',
    nome: p?.nome || 'Sem nome',
    dono_uid: p?.dono_uid || '',
    classe: classes || '—',
    nivel: Number(p?.nivel) || 0,
    pvAtual: Number(p?.pv_atual ?? 0),
    // `pv_max_override` e o maximo efetivo quando um efeito mexeu nele
    // (hp-descanso.js usa `char.pv_max_override || char.pv_max` na ficha).
    // Sem ele aqui, a tela do mestre mostraria "32/24" para quem recebeu
    // PV maximo temporario.
    pvMax: Number(p?.pv_max_override || p?.pv_max || 0),
    ca: Number(p?.ca) || 0,
    condicoes: Array.isArray(p?.condicoes) ? p.condicoes : [],
    atualizado_em: p?.atualizado_em || '',
  };
}

/**
 * Ordena as fichas da mesa para a tela do mestre: quem esta em perigo
 * primeiro (menor fracao de PV), depois por nome. O mestre olha essa
 * lista no meio do combate -- deixar o personagem a 2 PV no fim da lista,
 * em ordem alfabetica, e esconder justamente o que ele precisa ver.
 *
 * @param {Array<object>} resumos Saida de `resumoDoPersonagem`.
 * @returns {Array<object>} Nova lista ordenada; nao muta a recebida.
 */
export function ordenarParaMestre(resumos) {
  const fracao = (r) => (r.pvMax > 0 ? r.pvAtual / r.pvMax : 1);
  return [...(Array.isArray(resumos) ? resumos : [])]
    .sort((a, b) => fracao(a) - fracao(b) || String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
}
