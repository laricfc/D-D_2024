// ============================================================
// Autenticacao Firebase (Google Sign-In) + Firestore
// Modulo opcional: se nao logado, tudo funciona via localStorage
// ============================================================

import { podeSobrescreverNuvem } from './sync-merge.js';
import { normalizarTabelasInventario } from './regras-tabelas-item.js';

// Configuracao do projeto Firebase (produção).
//
// NÃO é segredo: este bloco é servido dentro do JavaScript que qualquer
// visitante baixa, e é assim por design no Firebase. Quem protege os
// dados são as regras em `firestore.rules`, aplicadas no servidor -- a
// apiKey só identifica o projeto.
//
// Projeto `dnd24-fichas` (conta de laricfc), 2026-11-22. O projeto
// anterior (`ded2024`) era do dono original do repositório e não é
// acessível por este; fichas que estavam na nuvem DELE não vêm junto --
// a migração é exportar/importar pela tela inicial.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB05lXDX7SBzOnSTOpooh6dYXx3GwOJEDE",
  authDomain: "dnd24-fichas.firebaseapp.com",
  projectId: "dnd24-fichas",
  storageBucket: "dnd24-fichas.firebasestorage.app",
  messagingSenderId: "838700886129",
  appId: "1:838700886129:web:f7e831b316689e358693d0",
  measurementId: "G-TG7PMWS8LX"
};

let _app = null;
let _auth = null;
let _db = null;
let _usuario = null;
let _inicializado = false;
let _inicializacao = null;
let _onAuthChangeCallbacks = [];

/**
 * Inicializa o Firebase de forma lazy (apenas quando necessario).
 * Carrega os scripts via importmap compat (ESM CDN).
 */
async function inicializarFirebase() {
  if (_inicializacao) return _inicializacao;
  _inicializacao = carregarFirebase();
  await _inicializacao;
  if (!_inicializado) _inicializacao = null;
}

/** Inicializa o SDK e aguarda a primeira restauração da sessão persistida. */
async function carregarFirebase() {
  try {
    // Importar Firebase App
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js');
    const { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } =
      await import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js');
    const { getFirestore } =
      await import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js');

    _app = initializeApp(FIREBASE_CONFIG);
    _auth = getAuth(_app);
    _db = getFirestore(_app);
    _inicializado = true;

    // Escutar mudancas de autenticacao
    await new Promise((resolve, reject) => {
      let primeiraResposta = true;
      onAuthStateChanged(_auth, (user) => {
        _usuario = user || null;
        _onAuthChangeCallbacks.forEach(cb => cb(_usuario));
        if (primeiraResposta) { primeiraResposta = false; resolve(); }
      }, (erro) => {
        if (primeiraResposta) { primeiraResposta = false; reject(erro); }
      });
    });
  } catch (err) {
    console.warn('Firebase nao disponivel (offline ou bloqueado):', err.message);
    _inicializado = false;
  }
}

/** Registra callback para mudanca de estado de autenticacao */
export function onAuthChange(callback) {
  _onAuthChangeCallbacks.push(callback);
  // Se ja inicializado, dispara imediatamente com estado atual
  if (_inicializado) callback(_usuario);
}

/** Retorna o usuario logado ou null */
export function getUsuario() {
  return _usuario;
}

/** Retorna true se o Firebase foi inicializado com sucesso */
export function firebaseDisponivel() {
  return _inicializado;
}

/**
 * Instância do Firestore, para os módulos que falam com coleções FORA de
 * `users/{uid}/personagens` -- hoje só `campanha.js`, que escreve no
 * espaço COMPARTILHADO (`campanhas/...`). As operações da ficha privada
 * continuam neste arquivo: quem precisa do `_db` para mexer em
 * `users/{uid}` está no lugar errado.
 * @returns {object|null} null enquanto o Firebase não inicializou.
 */
export function getDb() {
  return _db;
}

/** Os módulos do Firestore, carregados sob demanda do mesmo CDN e na
 *  mesma versão que este arquivo usa -- duas versões do SDK na página
 *  criariam duas instâncias de app. */
export function getFirestoreModules() {
  return _getFirestoreModules();
}

/** Login com Google via popup */
export async function loginComGoogle() {
  await inicializarFirebase();
  if (!_auth) throw new Error('Firebase nao inicializado');
  const { signInWithPopup, GoogleAuthProvider, setPersistence, browserLocalPersistence } =
    await import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js');
  // A sessão deve sobreviver ao recarregamento e ao fechamento da aba.
  await setPersistence(_auth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(_auth, provider);
  return result.user;
}

/** Logout */
export async function logout() {
  if (!_auth) return;
  const { signOut } = await import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js');
  await signOut(_auth);
  _usuario = null;
}

/** Inicializa Firebase em segundo plano (chamado no boot da app) */
export async function iniciarAuth() {
  await inicializarFirebase();
}

// ============================================================
// Operacoes Firestore para personagens
// ============================================================

async function _getFirestoreModules() {
  return import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js');
}

/**
 * Retorna a referencia da colecao de personagens do usuario logado.
 * Caminho: users/{uid}/personagens
 */
function _colecaoPath() {
  if (!_usuario) return null;
  return `users/${_usuario.uid}/personagens`;
}

/** Lista todos os personagens do Firestore */
export async function listarPersonagensCloud() {
  if (!_db || !_usuario) return [];
  const { collection, getDocs } = await _getFirestoreModules();
  const ref = collection(_db, _colecaoPath());
  const snap = await getDocs(ref);
  return snap.docs.map(doc => ({ ...doc.data(), _docId: doc.id }));
}

/** Salva ou atualiza um personagem no Firestore */
export async function salvarPersonagemCloud(personagem) {
  if (!_db || !_usuario) return { gravado: false, remoto: null };
  const { doc, runTransaction } = await _getFirestoreModules();
  // Usar o id do personagem como docId para facil lookup
  const docRef = doc(_db, _colecaoPath(), personagem.id);
  // Remover campos undefined que o Firestore nao aceita
  const dados = JSON.parse(JSON.stringify(personagem));
  // Ficha ainda não migrada (na fila ou não aberta desde a correção): o Firestore recusa array aninhado (#143).
  normalizarTabelasInventario(dados.inventario);
  // Transação: lê a versão da nuvem e só grava se ela não for mais nova. Antes era um
  // setDoc cego, e uma cópia velha presa na fila apagava edições feitas em outro aparelho.
  return runTransaction(_db, async (tx) => {
    const snap = await tx.get(docRef);
    const remoto = snap.exists() ? snap.data() : null;
    if (!podeSobrescreverNuvem(dados, remoto)) return { gravado: false, remoto };
    tx.set(docRef, dados);
    return { gravado: true, remoto: null };
  });
}

/**
 * Registra a exclusão de um personagem na nuvem como lápide no mesmo
 * documento (não apaga o documento): outros aparelhos que ainda têm a cópia
 * local passam a saber que ele foi excluído, em vez de recriá-lo.
 */
export async function removerPersonagemCloud(id) {
  if (!_db || !_usuario) return;
  const { doc, setDoc } = await _getFirestoreModules();
  const docRef = doc(_db, _colecaoPath(), id);
  const agora = new Date().toISOString();
  await setDoc(docRef, { id, removido: true, removido_em: agora, atualizado_em: agora });
}

/**
 * Busca todos os documentos de personagens da nuvem, lápides incluídas.
 * Usado pela reconciliação (sync-merge.js).
 */
export async function buscarEstadoCloud() {
  if (!_db || !_usuario) return [];
  const lista = await listarPersonagensCloud();
  // Remover metadado _docId do Firestore
  return lista.map(({ _docId, ...sem }) => sem);
}

/**
 * Busca o documento de UM personagem na nuvem (personagem ou lápide).
 * @param {string} id
 * @returns {Promise<object|null>} null se não existe, não há login ou o Firebase não está disponível.
 */
export async function buscarPersonagemCloud(id) {
  if (!_db || !_usuario) return null;
  const { doc, getDoc } = await _getFirestoreModules();
  const snap = await getDoc(doc(_db, _colecaoPath(), id));
  return snap.exists() ? snap.data() : null;
}

/**
 * Busca personagens da nuvem (Firestore), sem as lápides de exclusão.
 * Os personagens locais sao tratados separadamente (backup/restore).
 */
export async function buscarPersonagensCloud() {
  return (await buscarEstadoCloud()).filter(p => p.removido !== true);
}
