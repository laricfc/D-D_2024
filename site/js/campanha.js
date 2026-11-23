// ============================================================
// Campanha: o espaco COMPARTILHADO da mesa no Firestore.
//
// Tudo o que este modulo escreve vive em `campanhas/...`, nunca em
// `users/{uid}/personagens` -- a ficha privada continua em auth.js, e as
// duas nao se misturam: entrar numa campanha COPIA a ficha para a mesa,
// nao move. Quem sai da campanha continua com a dele.
//
// Estrutura:
//   campanhas/{id}          { nome, mestre_uid, mestre_nome, codigo, criada_em }
//   campanhas/{id}/membros/{uid}        { uid, nome, papel, entrou_em }
//   campanhas/{id}/personagens/{charId} { ...ficha, dono_uid, atualizado_em }
//   convites/{codigo}       { campanha_id, mestre_uid }
//
// O espelho do usuario ("de quais campanhas eu participo?") fica em
// `localStorage`, nao numa colecao: o Firestore nao deixa varrer
// `campanhas` (firestore.rules: `allow list: if false`), de proposito,
// para ninguem listar as mesas alheias.
//
// NENHUMA funcao daqui lanca por falta de login ou de rede: todas
// devolvem valor vazio ou `{ok:false, erro}`. O app inteiro funciona
// offline e sem conta, e a campanha e um extra que nao pode derrubar a
// ficha de quem nao usa.
// ============================================================
import { getDb, getFirestoreModules, getUsuario } from './auth.js';
import { gerarCodigoConvite, normalizarCodigo, codigoValido, papelNaCampanha } from './regras-campanha.js';
import { podeSobrescreverNuvem } from './sync-merge.js';
import { normalizarTabelasInventario } from './regras-tabelas-item.js';

// Campanhas de que este aparelho participa: [{id, nome, papel}]. Espelho
// local, porque `campanhas` nao pode ser varrida (ver cabecalho).
const CHAVE_MINHAS = 'campanhas_do_usuario';

/** Le o espelho local das campanhas deste aparelho. */
export function minhasCampanhas() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_MINHAS) || '[]');
    return Array.isArray(bruto) ? bruto : [];
  } catch {
    return [];
  }
}

/** Grava o espelho local, sem duplicar a mesma campanha. */
function guardarMinhas(lista) {
  const porId = new Map();
  for (const c of lista) if (c?.id) porId.set(c.id, c);
  try {
    localStorage.setItem(CHAVE_MINHAS, JSON.stringify([...porId.values()]));
  } catch {
    // Cota estourada ou armazenamento bloqueado: a campanha some da lista
    // deste aparelho, mas nada na nuvem se perde -- entrar de novo pelo
    // codigo recupera.
  }
}

/** Acrescenta (ou atualiza) uma campanha no espelho local. */
function lembrarCampanha(entrada) {
  guardarMinhas([...minhasCampanhas().filter((c) => c.id !== entrada.id), entrada]);
}

/** Tira a campanha do espelho local (sair da mesa neste aparelho). */
export function esquecerCampanha(id) {
  guardarMinhas(minhasCampanhas().filter((c) => c.id !== id));
}

/** Pronto para falar com o Firestore? Sem isso, toda operacao devolve erro. */
function contexto() {
  const db = getDb();
  const usuario = getUsuario();
  if (!db || !usuario) return null;
  return { db, usuario };
}

const SEM_LOGIN = { ok: false, erro: 'Entre com o Google para usar campanhas.' };

/**
 * Cria uma campanha com este usuario como mestre, e o convite que leva
 * ate ela.
 *
 * O codigo e sorteado e pode colidir com um ja existente -- a gravacao do
 * convite e condicional (`create` falha se o documento existir), entao a
 * colisao vira nova tentativa em vez de roubar o convite de outra mesa.
 *
 * @param {string} nome Nome da campanha.
 * @returns {Promise<{ok:boolean, id?:string, codigo?:string, erro?:string}>}
 */
export async function criarCampanha(nome) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const titulo = String(nome || '').trim();
  if (!titulo) return { ok: false, erro: 'Dê um nome à campanha.' };

  const { doc, setDoc, collection } = await getFirestoreModules();
  const { db, usuario } = ctx;
  const campanhaRef = doc(collection(db, 'campanhas'));
  const agora = new Date().toISOString();

  try {
    await setDoc(campanhaRef, {
      nome: titulo,
      mestre_uid: usuario.uid,
      mestre_nome: usuario.displayName || '',
      criada_em: agora,
    });
    // A inscricao do mestre entra como qualquer outra, para a tela poder
    // listar membros sem tratar o mestre como caso especial.
    await setDoc(doc(db, 'campanhas', campanhaRef.id, 'membros', usuario.uid), {
      uid: usuario.uid, nome: usuario.displayName || '', papel: 'mestre', entrou_em: agora,
    });

    const codigo = await reservarConvite(campanhaRef.id);
    if (!codigo.ok) return codigo;

    await setDoc(campanhaRef, { codigo: codigo.codigo }, { merge: true });
    lembrarCampanha({ id: campanhaRef.id, nome: titulo, papel: 'mestre' });
    return { ok: true, id: campanhaRef.id, codigo: codigo.codigo };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * Sorteia um codigo livre e grava o convite apontando para a campanha.
 * Tenta algumas vezes antes de desistir: com 31^6 combinacoes a colisao e
 * rara, mas "rara" nao e "impossivel" e o `create` condicional abaixo
 * recusa o codigo ja usado em vez de sobrescrever a mesa alheia.
 */
async function reservarConvite(campanhaId, tentativas = 5) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const { doc, setDoc } = await getFirestoreModules();
  const { db, usuario } = ctx;

  for (let i = 0; i < tentativas; i++) {
    const codigo = gerarCodigoConvite();
    try {
      // `setDoc` sem merge grava por cima; a protecao real contra roubo de
      // convite e a regra `update: resource.data.mestre_uid == uid`, que o
      // servidor aplica. Aqui o try/catch so transforma a recusa em nova
      // tentativa.
      await setDoc(doc(db, 'convites', codigo), {
        campanha_id: campanhaId, mestre_uid: usuario.uid,
      });
      return { ok: true, codigo };
    } catch {
      // Codigo tomado por outra mesa: sorteia outro.
    }
  }
  return { ok: false, erro: 'Não consegui gerar um código de convite. Tente de novo.' };
}

/**
 * Entra numa campanha pelo codigo de convite, criando a propria inscricao.
 * O mestre nao participa disso: entrar e ato do jogador (ver firestore.rules).
 *
 * @param {string} codigoDigitado Como o jogador digitou.
 * @returns {Promise<{ok:boolean, id?:string, nome?:string, erro?:string}>}
 */
export async function entrarNaCampanha(codigoDigitado) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const codigo = normalizarCodigo(codigoDigitado);
  if (!codigoValido(codigo)) return { ok: false, erro: 'Código inválido. São 6 letras e números.' };

  const { doc, getDoc, setDoc } = await getFirestoreModules();
  const { db, usuario } = ctx;
  try {
    const convite = await getDoc(doc(db, 'convites', codigo));
    if (!convite.exists()) return { ok: false, erro: 'Não achei campanha com esse código.' };
    const campanhaId = convite.data().campanha_id;

    const agora = new Date().toISOString();
    await setDoc(doc(db, 'campanhas', campanhaId, 'membros', usuario.uid), {
      uid: usuario.uid, nome: usuario.displayName || '', papel: 'jogador', entrou_em: agora,
    });

    // So DEPOIS de ser membro da para ler a campanha -- a regra `get` exige
    // a inscricao, que acabou de ser criada acima.
    const campanha = await getDoc(doc(db, 'campanhas', campanhaId));
    const nome = campanha.exists() ? campanha.data().nome : 'Campanha';
    lembrarCampanha({ id: campanhaId, nome, papel: 'jogador' });
    return { ok: true, id: campanhaId, nome };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * TODAS as campanhas do app, para o catalogo aberto.
 *
 * So funciona porque `firestore.rules` concede `list` a qualquer pessoa
 * logada -- ver o comentario la, que registra a decisao e o efeito dela.
 * Enquanto a regra era `list: if false`, esta funcao devolvia
 * permission-denied, e era esse o comportamento desejado.
 *
 * @returns {Promise<{ok:boolean, campanhas?:Array, erro?:string}>}
 */
export async function listarTodasCampanhas() {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const { collection, getDocs } = await getFirestoreModules();
  try {
    const snap = await getDocs(collection(ctx.db, 'campanhas'));
    const campanhas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Mais recentes primeiro: quem abre o catalogo quer ver a mesa que
    // acabou de ser criada, nao a mais antiga do banco.
    campanhas.sort((a, b) => String(b.criada_em || '').localeCompare(String(a.criada_em || '')));
    return { ok: true, campanhas };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * Entra numa campanha pelo ID, sem codigo -- o caminho do catalogo
 * aberto. `entrarNaCampanha` (por codigo) continua existindo para quem
 * recebe um convite direto; as duas criam a MESMA inscricao.
 *
 * @param {string} campanhaId
 * @param {string} nome Nome da campanha, para o espelho local.
 * @returns {Promise<{ok:boolean, erro?:string}>}
 */
export async function entrarPorId(campanhaId, nome = 'Campanha') {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const { doc, setDoc } = await getFirestoreModules();
  const { db, usuario } = ctx;
  try {
    await setDoc(doc(db, 'campanhas', campanhaId, 'membros', usuario.uid), {
      uid: usuario.uid, nome: usuario.displayName || '', papel: 'jogador',
      entrou_em: new Date().toISOString(),
    });
    lembrarCampanha({ id: campanhaId, nome, papel: 'jogador' });
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * Busca UMA ficha da campanha, inteira. E o que a tela do mestre abre ao
 * clicar em "Acessar Ficha" -- a lista ao vivo so traz o resumo.
 * @returns {Promise<object|null>} null se nao existe ou sem permissao.
 */
export async function buscarPersonagemDaCampanha(campanhaId, personagemId) {
  const ctx = contexto();
  if (!ctx) return null;
  const { doc, getDoc } = await getFirestoreModules();
  try {
    const snap = await getDoc(doc(ctx.db, 'campanhas', campanhaId, 'personagens', personagemId));
    return snap.exists() ? { ...snap.data(), id: personagemId } : null;
  } catch {
    return null;
  }
}

/**
 * Dados da campanha mais a lista de membros e o papel deste usuario.
 * @returns {Promise<{ok:boolean, campanha?:object, membros?:Array, papel?:string, erro?:string}>}
 */
export async function carregarCampanha(campanhaId) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const { doc, getDoc, collection, getDocs } = await getFirestoreModules();
  const { db, usuario } = ctx;
  try {
    const snap = await getDoc(doc(db, 'campanhas', campanhaId));
    if (!snap.exists()) return { ok: false, erro: 'Campanha não encontrada.' };
    const campanha = { id: campanhaId, ...snap.data() };
    const membrosSnap = await getDocs(collection(db, 'campanhas', campanhaId, 'membros'));
    const membros = membrosSnap.docs.map((d) => d.data());
    return { ok: true, campanha, membros, papel: papelNaCampanha(campanha, membros, usuario.uid) };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * Envia (ou atualiza) uma ficha na campanha.
 *
 * Usa a MESMA regra de conflito da sincronizacao privada
 * (`podeSobrescreverNuvem`, sync-merge.js): grava so se a copia que vai
 * subir nao for mais velha que a da nuvem. Com o mestre tambem editando,
 * essa e a unica barreira contra o aparelho que ficou um tempo sem rede
 * apagar o que o outro acabou de fazer.
 *
 * LIMITE CONHECIDO: a gravacao e do documento INTEIRO, entao duas edicoes
 * simultaneas nao se fundem campo a campo -- a mais recente vence por
 * completo. Numa mesa isso quase sempre basta; se virar problema, o passo
 * seguinte e gravar PV e condicoes em campos separados.
 *
 * @param {string} campanhaId
 * @param {object} personagem Ficha completa.
 * @returns {Promise<{ok:boolean, gravado?:boolean, erro?:string}>}
 */
export async function enviarPersonagem(campanhaId, personagem) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  if (!personagem?.id) return { ok: false, erro: 'Personagem sem id.' };
  const { doc, runTransaction } = await getFirestoreModules();
  const { db, usuario } = ctx;

  // JSON.parse(JSON.stringify(...)): o Firestore recusa `undefined`, e a
  // ficha tem campos opcionais. Mesmo tratamento de salvarPersonagemCloud.
  const dados = JSON.parse(JSON.stringify(personagem));
  // Array aninhado quebra o Firestore (#143) -- mesma normalizacao da
  // sincronizacao privada.
  normalizarTabelasInventario(dados.inventario);
  dados.atualizado_em = dados.atualizado_em || new Date().toISOString();

  const ref = doc(db, 'campanhas', campanhaId, 'personagens', personagem.id);
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const remoto = snap.exists() ? snap.data() : null;
      // `dono_uid` e carimbado na PRIMEIRA gravacao e nunca muda depois:
      // firestore.rules recusa o update que o altera, e reescreve-lo aqui
      // transformaria a recusa do servidor num erro sem explicacao.
      const dono = remoto?.dono_uid || usuario.uid;
      if (remoto && !podeSobrescreverNuvem(dados, remoto)) return { ok: true, gravado: false };
      tx.set(ref, { ...dados, dono_uid: dono });
      return { ok: true, gravado: true };
    });
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/** Tira a ficha da campanha (a copia privada do jogador nao e tocada). */
export async function removerPersonagemDaCampanha(campanhaId, personagemId) {
  const ctx = contexto();
  if (!ctx) return SEM_LOGIN;
  const { doc, deleteDoc } = await getFirestoreModules();
  try {
    await deleteDoc(doc(ctx.db, 'campanhas', campanhaId, 'personagens', personagemId));
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: mensagemDeErro(err) };
  }
}

/**
 * Acompanha AO VIVO as fichas da campanha. E o que faz a tela do mestre
 * mudar sozinha quando o jogador edita: o Firestore empurra a alteracao
 * em segundos, sem recarregar a pagina nem botao de atualizar.
 *
 * @param {string} campanhaId
 * @param {(personagens: Array<object>) => void} aoMudar Chamado a cada
 *   alteracao, com a lista inteira.
 * @param {(erro: string) => void} [aoFalhar] Chamado se a escuta cair
 *   (perda de permissao, rede). A tela deve DIZER que parou de acompanhar
 *   -- uma lista velha sem aviso e pior do que lista nenhuma.
 * @returns {() => void} Encerra a escuta. SEMPRE chame ao sair da tela:
 *   escuta viva depois do render seguinte vaza memoria e custa leitura.
 */
export function acompanharPersonagens(campanhaId, aoMudar, aoFalhar = () => {}) {
  let cancelar = () => {};
  let cancelado = false;

  (async () => {
    const ctx = contexto();
    if (!ctx) { aoFalhar(SEM_LOGIN.erro); return; }
    try {
      const { collection, onSnapshot } = await getFirestoreModules();
      if (cancelado) return; // a tela saiu enquanto o SDK carregava
      const ref = collection(ctx.db, 'campanhas', campanhaId, 'personagens');
      cancelar = onSnapshot(ref,
        (snap) => aoMudar(snap.docs.map((d) => ({ ...d.data(), id: d.id }))),
        (err) => aoFalhar(mensagemDeErro(err)));
    } catch (err) {
      aoFalhar(mensagemDeErro(err));
    }
  })();

  return () => { cancelado = true; cancelar(); };
}

// ============================================================
// Republicacao: a ficha do jogador espelhada na mesa a cada salvamento.
//
// Fila PROPRIA, separada da fila de sync.js, de proposito. As duas
// resolvem o mesmo problema (gravar quando a rede voltar), mas uma falha
// na campanha -- regra nao publicada, jogador removido da mesa -- nao
// pode marcar a sincronizacao da ficha PRIVADA como quebrada nem travar
// a fila dela. Sao dois destinos independentes e falham de forma
// independente.
// ============================================================
const CHAVE_FILA_PUB = 'campanha_fila_publicacao';
const MAX_TENTATIVAS_PUB = 5;
const ESPERA_RETENTATIVA_MS = 30_000;
let _publicando = false;
let _ultimaFalhaPublicacao = '';

/** Le a fila de republicacao. */
function lerFilaPub() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_FILA_PUB) || '[]');
    return Array.isArray(bruto) ? bruto : [];
  } catch {
    return [];
  }
}

/** Grava a fila de republicacao. */
function salvarFilaPub(fila) {
  try {
    localStorage.setItem(CHAVE_FILA_PUB, JSON.stringify(fila));
  } catch {
    // Sem espaco: a republicacao desta edicao se perde, mas a ficha local
    // esta salva e o proximo salvamento tenta de novo.
  }
}

/**
 * A ultima falha de republicacao, para a tela poder dizer que a mesa
 * pode estar desatualizada. '' quando esta tudo publicado.
 */
export function ultimaFalhaPublicacao() {
  return _ultimaFalhaPublicacao;
}

/**
 * Espelha a ficha na campanha a que ela esta vinculada. Chamada a cada
 * `salvarPersonagem` (store.js); e um no-op barato para quem nao esta em
 * campanha nenhuma, que e a maioria.
 *
 * NAO espera a rede: enfileira e devolve. O salvamento da ficha nao pode
 * ficar lento nem falhar por causa da mesa.
 *
 * @param {object} personagem Ficha recem-salva.
 */
export function publicarNaCampanha(personagem) {
  const campanhaId = personagem?.campanha_id;
  if (!campanhaId || !personagem?.id) return;
  if (!getUsuario()) return; // sem conta nao ha onde publicar

  // Upsert por (campanha, personagem): a fila guarda a ULTIMA versao, nao
  // o historico -- republicar uma edicao intermediaria nao serve para nada
  // e so gasta escrita.
  const fila = lerFilaPub().filter((e) => !(e.campanhaId === campanhaId && e.id === personagem.id));
  fila.push({
    campanhaId, id: personagem.id, tentativas: 0,
    dados: JSON.parse(JSON.stringify(personagem)),
  });
  salvarFilaPub(fila);

  if (navigator.onLine) processarFilaCampanha();
}

/**
 * Esvazia a fila de republicacao. Chamada ao salvar, ao voltar a conexao
 * e no boot. Segura para ser chamada varias vezes: a guarda
 * `_publicando` impede duas passadas ao mesmo tempo.
 */
export async function processarFilaCampanha() {
  if (_publicando) return;
  const fila = lerFilaPub();
  if (!fila.length || !contexto()) return;

  _publicando = true;
  let falhou = false;

  for (const entrada of [...fila]) {
    const r = await enviarPersonagem(entrada.campanhaId, entrada.dados);
    const atual = lerFilaPub();
    const idx = atual.findIndex((e) => e.campanhaId === entrada.campanhaId && e.id === entrada.id);

    if (r.ok) {
      // `gravado: false` tambem sai da fila: significa que a nuvem ja tem
      // uma versao MAIS NOVA (o mestre editou), e insistir com a nossa,
      // mais velha, so reescreveria por cima do que acabou de chegar.
      if (idx >= 0) { atual.splice(idx, 1); salvarFilaPub(atual); }
      _ultimaFalhaPublicacao = '';
      continue;
    }

    falhou = true;
    _ultimaFalhaPublicacao = r.erro || 'Falha ao publicar na campanha.';
    if (idx >= 0) {
      atual[idx].tentativas = (atual[idx].tentativas || 0) + 1;
      // Desiste depois de algumas tentativas em vez de reenviar para
      // sempre: com a regra nao publicada, cada tentativa e uma leitura
      // cobrada que nunca vai dar certo.
      if (atual[idx].tentativas >= MAX_TENTATIVAS_PUB) atual.splice(idx, 1);
      salvarFilaPub(atual);
    }
    console.warn('Republicação na campanha falhou:', r.erro);
  }

  _publicando = false;
  if (falhou && lerFilaPub().length) setTimeout(processarFilaCampanha, ESPERA_RETENTATIVA_MS);
}

/** Retoma a republicacao quando a conexao volta. Chamada no boot. */
export function inicializarCampanha() {
  window.addEventListener('online', () => processarFilaCampanha());
  if (navigator.onLine) processarFilaCampanha();
}

/**
 * Traduz o erro do Firestore para o que o jogador precisa fazer.
 * `permission-denied` quase sempre significa regra nao publicada -- sem
 * essa dica, o sintoma e mudo e parece bug do app.
 */
function mensagemDeErro(err) {
  const codigo = err?.code || '';
  if (codigo.includes('permission-denied')) {
    // NAO afirmar a causa. `permission-denied` tem varias, e a primeira
    // versao desta mensagem cravava "as regras nao estao publicadas" --
    // com as regras publicadas e corretas, ela mandou procurar no lugar
    // errado um defeito que estava na propria regra. Listar as causas
    // prováveis ajuda; escolher uma delas por palpite atrapalha.
    return 'Sem permissão para esta operação. Pode ser que você não seja membro desta campanha, que a ficha seja de outra pessoa, ou que as regras do Firestore precisem ser republicadas.';
  }
  if (codigo.includes('unavailable') || codigo.includes('failed-precondition')) {
    return 'Sem conexão com a nuvem agora. Sua ficha continua salva neste aparelho.';
  }
  return err?.message || 'Falha ao falar com a nuvem.';
}
