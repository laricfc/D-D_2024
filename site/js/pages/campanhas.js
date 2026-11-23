// ============================================================
// Tela de campanhas na home: criar, entrar por codigo, e a mesa ao vivo.
//
// Camada de tela de campanha.js (Firestore) e regras-campanha.js (puro).
// Nenhuma regra mora aqui: esta arquivo so monta HTML, liga clique e
// mostra erro.
//
// O bloco nasce RECOLHIDO (diretriz do CLAUDE.md) e cada campanha e um
// CARD clicavel, nao um item de dropdown -- cada entrada tem nome, papel
// e codigo, e clicar abre a mesa num popup.
// ============================================================
import {
  acompanharPersonagens, buscarPersonagemDaCampanha, carregarCampanha, criarCampanha,
  entrarNaCampanha, entrarPorId, enviarPersonagem, esquecerCampanha,
  listarTodasCampanhas, minhasCampanhas,
} from '../campanha.js';
import { ordenarParaMestre, resumoDoPersonagem } from '../regras-campanha.js';
import { getUsuario } from '../auth.js';
import { listarPersonagens, salvarPersonagem } from '../store.js';
import { renderSheet } from './sheet.js';
import { abrirModal, escHtml, toast } from '../utils.js';

// A escuta ao vivo da mesa aberta agora. Guardada em modulo porque o
// popup pode ser fechado de varias formas (X, clique fora, Esc) e a
// escuta precisa morrer em todas elas -- escuta viva depois de fechar
// vaza memoria e continua custando leitura do Firestore.
let _pararDeAcompanhar = null;

/** Encerra a escuta da mesa, se houver. Idempotente. */
function pararEscuta() {
  if (_pararDeAcompanhar) _pararDeAcompanhar();
  _pararDeAcompanhar = null;
}

/**
 * Bloco "Campanhas" da home. Sempre presente: sem login ele explica o que
 * falta, em vez de sumir e deixar o recurso invisivel.
 * @returns {string} HTML do bloco.
 */
export function renderSecaoCampanhas() {
  const usuario = getUsuario();
  const campanhas = minhasCampanhas();
  const resumo = usuario
    ? `${campanhas.length} campanha${campanhas.length === 1 ? '' : 's'}`
    : 'precisa de conta';

  const corpo = !usuario
    ? `<p class="campanha-aviso">Campanha é a mesa compartilhada: os jogadores enviam a ficha e o mestre acompanha as alterações ao vivo. Para usar, entre com o Google acima — os personagens precisam de um lugar na nuvem para serem compartilhados.</p>`
    : `
      <div class="campanha-acoes">
        <button class="btn btn-sm btn-primary" onclick="navegar('campanhas')">Ver todas as campanhas</button>
        <button class="btn btn-sm btn-secondary" id="btn-criar-campanha">+ Criar</button>
        <button class="btn btn-sm btn-secondary" id="btn-entrar-campanha">Entrar com código</button>
      </div>
      ${campanhas.length === 0
        ? '<p class="campanha-aviso">Você ainda não participa de nenhuma campanha. Crie uma para mestrar, ou entre na de outra pessoa com o código que ela te passar.</p>'
        : `<div class="campanha-cards">${campanhas.map(cardCampanha).join('')}</div>`}`;

  return `
    <details class="card campanha-bloco" data-details-id="campanhas-home">
      <summary class="campanha-sumario">
        <span>🎲 Campanhas</span>
        <span class="campanha-sumario-resumo">${escHtml(resumo)}</span>
      </summary>
      <div class="campanha-conteudo">${corpo}</div>
    </details>`;
}

/** Card de uma campanha do espelho local. */
function cardCampanha(c) {
  return `
    <button class="campanha-card" data-abrir-campanha="${escHtml(c.id)}">
      <span class="campanha-card-nome">${escHtml(c.nome || 'Campanha')}</span>
      <span class="campanha-card-sub">${c.papel === 'mestre' ? 'Você é o mestre' : 'Jogador'}</span>
    </button>`;
}

/** Liga os cliques do bloco. Chamada pelo setup da home a cada render. */
export function setupEventosCampanhas(container) {
  container.querySelector('#btn-criar-campanha')?.addEventListener('click', perguntarNomeDaCampanha);
  container.querySelector('#btn-entrar-campanha')?.addEventListener('click', perguntarCodigo);
  container.querySelectorAll('[data-abrir-campanha]').forEach((el) => {
    el.addEventListener('click', () => abrirMesa(el.dataset.abrirCampanha));
  });
}

/** Popup de criar campanha. */
function perguntarNomeDaCampanha() {
  abrirModal('Nova campanha', `
    <label class="campanha-rotulo" for="campo-nome-campanha">Nome da campanha</label>
    <input id="campo-nome-campanha" class="input" maxlength="60" placeholder="A Maldição de Strahd">
    <p class="campanha-aviso">Você será o mestre. Depois de criar, um código de convite aparece para você passar aos jogadores.</p>
  `, '<button class="btn btn-accent" id="btn-confirmar-criar-campanha">Criar</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>');

  document.getElementById('btn-confirmar-criar-campanha')?.addEventListener('click', async () => {
    const nome = document.getElementById('campo-nome-campanha')?.value || '';
    const r = await criarCampanha(nome);
    if (!r.ok) { toast(r.erro, 'error'); return; }
    window.fecharModalTodos();
    mostrarCodigo(r.codigo);
  });
}

/** Mostra o codigo recem-criado, para o mestre copiar e passar. */
function mostrarCodigo(codigo) {
  abrirModal('Campanha criada', `
    <p>Passe este código para os jogadores entrarem:</p>
    <div class="campanha-codigo">${escHtml(codigo)}</div>
    <p class="campanha-aviso">Quem tiver o código entra na mesa. Cada jogador envia a própria ficha; você não puxa ficha de ninguém.</p>
  `, '<button class="btn btn-secondary" onclick="fecharModal()">Fechar</button>');
  // A home precisa mostrar a campanha nova na lista.
  window.navegar?.('home');
}

/** Popup de entrar por codigo. */
function perguntarCodigo() {
  abrirModal('Entrar numa campanha', `
    <label class="campanha-rotulo" for="campo-codigo-campanha">Código de convite</label>
    <input id="campo-codigo-campanha" class="input campanha-codigo-campo" maxlength="9" placeholder="ABC234" autocapitalize="characters">
    <p class="campanha-aviso">São 6 letras e números. Maiúsculas, minúsculas e hífen dão no mesmo.</p>
  `, '<button class="btn btn-accent" id="btn-confirmar-entrar-campanha">Entrar</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>');

  document.getElementById('btn-confirmar-entrar-campanha')?.addEventListener('click', async () => {
    const codigo = document.getElementById('campo-codigo-campanha')?.value || '';
    const r = await entrarNaCampanha(codigo);
    if (!r.ok) { toast(r.erro, 'error'); return; }
    window.fecharModalTodos();
    toast(`Você entrou em ${r.nome}.`, 'success');
    window.navegar?.('home');
  });
}

/**
 * A mesa ao vivo. Abre o popup com a lista e liga o `onSnapshot`: daqui
 * em diante a lista muda sozinha quando qualquer jogador edita a ficha.
 */
async function abrirMesa(campanhaId) {
  const dados = await carregarCampanha(campanhaId);
  if (!dados.ok) { toast(dados.erro, 'error'); return; }
  const { campanha, membros, papel } = dados;

  const rodape = `
    <button class="btn btn-secondary" id="btn-enviar-ficha">Enviar meu personagem</button>
    <button class="btn btn-secondary" onclick="fecharModal()">Fechar</button>`;

  // onClose do modal principal: a escuta morre junto com a tela.
  abrirModal(campanha.nome || 'Campanha', corpoDaMesa(campanha, membros, papel, null), rodape, pararEscuta);

  document.getElementById('btn-enviar-ficha')?.addEventListener('click', () => escolherFichaParaEnviar(campanhaId));

  pararEscuta();
  _pararDeAcompanhar = acompanharPersonagens(campanhaId,
    (personagens) => {
      const alvo = document.getElementById('campanha-mesa');
      if (!alvo) return; // popup ja fechou
      alvo.innerHTML = listaDaMesa(personagens, papel, campanhaId);
      ligarAcoesDoMestre(campanhaId, personagens, papel);
    },
    (erro) => {
      const alvo = document.getElementById('campanha-mesa');
      // A lista parou de acompanhar: dizer isso importa mais do que
      // manter numeros antigos na tela como se fossem atuais.
      if (alvo) alvo.innerHTML = `<p class="campanha-erro">${escHtml(erro)}</p>`;
    });
}

/** Cabecalho da mesa + o container que a escuta ao vivo preenche. */
function corpoDaMesa(campanha, membros, papel) {
  return `
    <div class="campanha-mesa-topo">
      <span class="campanha-papel">${papel === 'mestre' ? '🎩 Você é o mestre' : '🎭 Jogador'}</span>
      <span class="campanha-membros">${membros.length} na mesa</span>
      ${papel === 'mestre' && campanha.codigo
        ? `<span class="campanha-codigo-inline" title="Código de convite">${escHtml(campanha.codigo)}</span>` : ''}
    </div>
    <div id="campanha-mesa"><p class="campanha-aviso">Carregando as fichas da mesa…</p></div>`;
}

/** A lista de fichas, ja ordenada por quem esta pior de PV. */
function listaDaMesa(personagens, papel, campanhaId) {
  if (!personagens.length) {
    return '<p class="campanha-aviso">Nenhuma ficha enviada ainda. Use "Enviar meu personagem" abaixo.</p>';
  }
  const resumos = ordenarParaMestre(personagens.map(resumoDoPersonagem));
  return `<div class="campanha-fichas">${resumos.map((r) => linhaDaFicha(r, papel)).join('')}</div>`;
}

/** Uma ficha na mesa: nome, classe, PV, CA e condicoes. */
function linhaDaFicha(r, papel) {
  const fracao = r.pvMax > 0 ? r.pvAtual / r.pvMax : 1;
  const tom = fracao <= 0 ? 'morto' : fracao <= 0.33 ? 'perigo' : fracao <= 0.66 ? 'atencao' : 'ok';
  return `
    <div class="campanha-ficha campanha-ficha-${tom}">
      <div class="campanha-ficha-cabeca">
        <strong>${escHtml(r.nome)}</strong>
        <span class="campanha-ficha-classe">${escHtml(r.classe)}</span>
      </div>
      <div class="campanha-ficha-numeros">
        <span class="campanha-pv">${r.pvAtual}/${r.pvMax} PV</span>
        <span class="campanha-ca">CA ${r.ca}</span>
      </div>
      ${r.condicoes.length ? `<div class="campanha-condicoes">${r.condicoes.map((c) => `<span class="campanha-condicao">${escHtml(c)}</span>`).join('')}</div>` : ''}
      ${papel === 'mestre' ? `
        <div class="campanha-ficha-acoes no-print">
          <button class="btn btn-sm btn-danger" data-mestre-dano="${escHtml(r.id)}">− Dano</button>
          <button class="btn btn-sm btn-secondary" data-mestre-cura="${escHtml(r.id)}">+ Cura</button>
        </div>` : ''}
    </div>`;
}

/** Liga os botoes que so o mestre ve. */
function ligarAcoesDoMestre(campanhaId, personagens, papel) {
  if (papel !== 'mestre') return;
  const achar = (id) => personagens.find((p) => p.id === id);
  document.querySelectorAll('[data-mestre-dano]').forEach((el) => {
    el.addEventListener('click', () => pedirValor(campanhaId, achar(el.dataset.mestreDano), -1));
  });
  document.querySelectorAll('[data-mestre-cura]').forEach((el) => {
    el.addEventListener('click', () => pedirValor(campanhaId, achar(el.dataset.mestreCura), +1));
  });
}

/**
 * Pergunta quanto, e grava o PV novo na ficha da campanha.
 * @param {number} sinal -1 para dano, +1 para cura.
 */
function pedirValor(campanhaId, personagem, sinal) {
  if (!personagem) return;
  const titulo = sinal < 0 ? 'Aplicar dano' : 'Curar';
  abrirModal(`${titulo} — ${personagem.nome || 'ficha'}`, `
    <label class="campanha-rotulo" for="campo-valor-pv">Quantos pontos?</label>
    <input id="campo-valor-pv" class="input" type="number" min="0" inputmode="numeric" value="1">
  `, `<button class="btn btn-accent" id="btn-confirmar-pv">${titulo}</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>`);

  document.getElementById('btn-confirmar-pv')?.addEventListener('click', async () => {
    const valor = Math.max(0, parseInt(document.getElementById('campo-valor-pv')?.value, 10) || 0);
    if (valor === 0) { window.fecharModal(); return; }
    const maximo = Number(personagem.pv_max_override || personagem.pv_max || 0);
    const atual = Number(personagem.pv_atual || 0);
    const novo = Math.max(0, Math.min(maximo, atual + sinal * valor));
    // `atualizado_em` novo e o que faz esta gravacao vencer a copia da
    // nuvem em podeSobrescreverNuvem -- sem ele a transacao recusaria a
    // propria escrita do mestre.
    const r = await enviarPersonagem(campanhaId, {
      ...personagem, pv_atual: novo, atualizado_em: new Date().toISOString(),
    });
    window.fecharModal();
    if (!r.ok) { toast(r.erro, 'error'); return; }
    if (!r.gravado) { toast('O jogador alterou a ficha agora há pouco. Tente de novo.', 'error'); return; }
    toast(`${personagem.nome}: ${atual} → ${novo} PV.`, 'success');
  });
}

/** Escolhe qual ficha deste aparelho enviar para a mesa. */
function escolherFichaParaEnviar(campanhaId) {
  const locais = listarPersonagens();
  if (!locais.length) { toast('Você não tem personagem neste aparelho.', 'error'); return; }
  abrirModal('Enviar personagem', `
    <p class="campanha-aviso">A ficha é <strong>copiada</strong> para a mesa. A sua continua aqui, e o mestre passa a ver as alterações.</p>
    <div class="campanha-cards">
      ${locais.map((p) => `
        <button class="campanha-card" data-enviar-personagem="${escHtml(p.id)}">
          <span class="campanha-card-nome">${escHtml(p.nome || 'Sem nome')}</span>
          <span class="campanha-card-sub">${escHtml([p.classe, p.nivel ? `nível ${p.nivel}` : ''].filter(Boolean).join(' · '))}</span>
        </button>`).join('')}
    </div>
  `, '<button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>');

  document.querySelectorAll('[data-enviar-personagem]').forEach((el) => {
    el.addEventListener('click', async () => {
      const p = locais.find((x) => x.id === el.dataset.enviarPersonagem);
      if (!p) return;
      // Carimba o vinculo na copia LOCAL para a ficha saber que tem de
      // publicar as proximas edicoes nesta mesa.
      const comVinculo = { ...p, campanha_id: campanhaId, atualizado_em: new Date().toISOString() };
      salvarPersonagem(comVinculo);
      const r = await enviarPersonagem(campanhaId, comVinculo);
      window.fecharModal();
      toast(r.ok ? `${p.nome || 'Personagem'} entrou na mesa.` : r.erro, r.ok ? 'success' : 'error');
    });
  });
}

/** Sair da campanha neste aparelho (nao apaga nada da nuvem). */
export function sairDaCampanhaLocal(id) {
  esquecerCampanha(id);
}

// ============================================================
// Paginas (rotas #campanhas, #campanha/{id}, #fichacampanha/{c}/{p})
// ============================================================

/**
 * Catalogo aberto: TODAS as campanhas do app. Decisao do dono do produto
 * -- qualquer pessoa logada ve e entra em qualquer mesa. Ver o
 * comentario em firestore.rules, que registra o efeito disso nas fichas.
 */
export async function renderListaCampanhas(container) {
  if (!getUsuario()) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>Entre com o Google</h2>
        <p>As campanhas vivem na nuvem; sem conta não há onde compartilhar.</p>
        <button class="btn btn-primary" onclick="navegar('home')">Voltar</button>
      </div>`;
    return;
  }

  container.innerHTML = '<p class="campanha-aviso">Carregando campanhas…</p>';
  const r = await listarTodasCampanhas();
  if (!r.ok) { container.innerHTML = `<p class="campanha-erro">${escHtml(r.erro)}</p>`; return; }

  const minhas = new Set(minhasCampanhas().map((c) => c.id));
  const uid = getUsuario().uid;

  container.innerHTML = `
    <div class="campanha-pagina-topo">
      <h2>Campanhas</h2>
      <button class="btn btn-sm btn-primary" id="btn-criar-campanha">+ Nova campanha</button>
    </div>
    ${r.campanhas.length === 0
      ? '<p class="campanha-aviso">Nenhuma campanha ainda. Crie a primeira.</p>'
      : `<div class="campanha-grade">${r.campanhas.map((c) => cartaoDeCampanha(c, uid, minhas.has(c.id))).join('')}</div>`}`;

  container.querySelector('#btn-criar-campanha')?.addEventListener('click', perguntarNomeDaCampanha);
  ligarBotoesDoCartao(container);
}

/** Cartao de campanha do catalogo, com as acoes embaixo. */
function cartaoDeCampanha(c, uid, souMembro) {
  const souMestre = c.mestre_uid === uid;
  const papel = souMestre ? 'Mestre' : souMembro ? 'Jogador' : '';
  return `
    <div class="campanha-cartao">
      <div class="campanha-cartao-cabeca">
        <h3>${escHtml(c.nome || 'Campanha')}</h3>
        ${papel ? `<span class="campanha-etiqueta">${papel}</span>` : ''}
      </div>
      <p class="campanha-cartao-sub">Mestre: ${escHtml(c.mestre_nome || '—')}</p>
      <div class="campanha-cartao-acoes">
        ${souMembro
          ? `<button class="btn btn-sm btn-primary" data-abrir-mesa="${escHtml(c.id)}">Acessar</button>
             <button class="btn btn-sm btn-secondary" data-add-ficha="${escHtml(c.id)}">Adicionar minha ficha</button>
             <button class="btn btn-sm btn-secondary" data-criar-ficha="${escHtml(c.id)}">Criar uma ficha</button>`
          : `<button class="btn btn-sm btn-accent" data-entrar-campanha-id="${escHtml(c.id)}" data-nome-campanha="${escHtml(c.nome || 'Campanha')}">Entrar</button>`}
      </div>
    </div>`;
}

/** Liga as acoes dos cartoes do catalogo. */
function ligarBotoesDoCartao(container) {
  container.querySelectorAll('[data-entrar-campanha-id]').forEach((el) => {
    el.addEventListener('click', async () => {
      const r = await entrarPorId(el.dataset.entrarCampanhaId, el.dataset.nomeCampanha);
      if (!r.ok) { toast(r.erro, 'error'); return; }
      toast(`Você entrou em ${el.dataset.nomeCampanha}.`, 'success');
      window.navegar('campanhas');
      renderListaCampanhas(container);
    });
  });
  container.querySelectorAll('[data-abrir-mesa]').forEach((el) => {
    el.addEventListener('click', () => window.navegar(`campanha/${el.dataset.abrirMesa}`));
  });
  container.querySelectorAll('[data-add-ficha]').forEach((el) => {
    el.addEventListener('click', () => escolherFichaParaEnviar(el.dataset.addFicha));
  });
  container.querySelectorAll('[data-criar-ficha]').forEach((el) => {
    el.addEventListener('click', () => {
      // O criador termina e o personagem entra na mesa sozinho: quem
      // guarda a intenção é esta chave, lida no fim do assistente.
      try { localStorage.setItem('campanha_destino_novo_personagem', el.dataset.criarFicha); } catch { /* sem espaço: cai no envio manual */ }
      window.navegar('criar');
    });
  });
}

/**
 * Página de UMA campanha: as fichas da mesa, ao vivo, em cartões -- e não
 * o resumo apertado do popup. É daqui que o mestre abre a ficha inteira.
 */
export async function renderPaginaCampanha(container, campanhaId) {
  if (!campanhaId) { window.navegar('campanhas'); return; }
  container.innerHTML = '<p class="campanha-aviso">Carregando a mesa…</p>';
  const dados = await carregarCampanha(campanhaId);
  if (!dados.ok) { container.innerHTML = `<p class="campanha-erro">${escHtml(dados.erro)}</p>`; return; }
  const { campanha, membros, papel } = dados;

  container.innerHTML = `
    <div class="campanha-pagina-topo">
      <h2>${escHtml(campanha.nome || 'Campanha')}</h2>
      <div class="campanha-cartao-acoes">
        <button class="btn btn-sm btn-secondary" data-add-ficha="${escHtml(campanhaId)}">Adicionar minha ficha</button>
        <button class="btn btn-sm btn-secondary" data-criar-ficha="${escHtml(campanhaId)}">Criar uma ficha</button>
      </div>
    </div>
    <div class="campanha-mesa-topo">
      <span class="campanha-papel">${papel === 'mestre' ? '🎩 Você é o mestre' : '🎭 Jogador'}</span>
      <span class="campanha-membros">${membros.length} na mesa</span>
      ${campanha.codigo ? `<span class="campanha-codigo-inline" title="Código de convite">${escHtml(campanha.codigo)}</span>` : ''}
    </div>
    <div id="campanha-mesa"><p class="campanha-aviso">Carregando as fichas…</p></div>`;

  ligarBotoesDoCartao(container);

  pararEscuta();
  _pararDeAcompanhar = acompanharPersonagens(campanhaId,
    (personagens) => {
      const alvo = document.getElementById('campanha-mesa');
      if (!alvo) return;
      alvo.innerHTML = gradeDeFichas(personagens, papel, campanhaId);
      ligarAcoesDoMestre(campanhaId, personagens, papel);
      alvo.querySelectorAll('[data-abrir-ficha]').forEach((el) => {
        el.addEventListener('click', () =>
          window.navegar(`fichacampanha/${campanhaId}/${el.dataset.abrirFicha}`));
      });
    },
    (erro) => {
      const alvo = document.getElementById('campanha-mesa');
      if (alvo) alvo.innerHTML = `<p class="campanha-erro">${escHtml(erro)}</p>`;
    });
}

/** Cartões das fichas da mesa, com acesso à ficha inteira. */
function gradeDeFichas(personagens, papel, campanhaId) {
  if (!personagens.length) {
    return '<p class="campanha-aviso">Nenhuma ficha na mesa ainda. Use "Adicionar minha ficha" ou "Criar uma ficha" acima.</p>';
  }
  const resumos = ordenarParaMestre(personagens.map(resumoDoPersonagem));
  return `<div class="campanha-grade">${resumos.map((r) => cartaoDeFicha(r, papel)).join('')}</div>`;
}

/** Um personagem da mesa como cartão, no formato da referência. */
function cartaoDeFicha(r, papel) {
  const fracao = r.pvMax > 0 ? r.pvAtual / r.pvMax : 1;
  const tom = fracao <= 0 ? 'morto' : fracao <= 0.33 ? 'perigo' : fracao <= 0.66 ? 'atencao' : 'ok';
  return `
    <div class="campanha-cartao campanha-ficha-${tom}">
      <div class="campanha-cartao-cabeca">
        <h3>${escHtml(r.nome)}</h3>
      </div>
      <p class="campanha-cartao-sub">${escHtml(r.classe)}</p>
      <div class="campanha-ficha-numeros">
        <span class="campanha-pv">${r.pvAtual}/${r.pvMax} PV</span>
        <span class="campanha-ca">CA ${r.ca}</span>
      </div>
      ${r.condicoes.length ? `<div class="campanha-condicoes">${r.condicoes.map((c) => `<span class="campanha-condicao">${escHtml(c)}</span>`).join('')}</div>` : ''}
      <div class="campanha-cartao-acoes">
        <button class="btn btn-sm btn-primary" data-abrir-ficha="${escHtml(r.id)}">Acessar Ficha</button>
        ${papel === 'mestre' ? `
          <button class="btn btn-sm btn-danger" data-mestre-dano="${escHtml(r.id)}">− Dano</button>
          <button class="btn btn-sm btn-secondary" data-mestre-cura="${escHtml(r.id)}">+ Cura</button>` : ''}
      </div>
    </div>`;
}

/**
 * A ficha INTEIRA de um personagem da mesa, no mesmo renderizador da
 * ficha normal. `renderSheet` recebe o personagem já carregado e o id da
 * campanha -- a partir daí `salvar()` (estado.js) grava na mesa, nunca na
 * lista local de quem está olhando.
 *
 * @param {HTMLElement} container
 * @param {string} param "campanhaId/personagemId", como o router entrega.
 */
export async function renderFichaDeCampanha(container, param) {
  const [campanhaId, personagemId] = String(param || '').split('/');
  if (!campanhaId || !personagemId) { window.navegar('campanhas'); return; }
  pararEscuta(); // a mesa ficou para trás; a escuta dela não pode sobreviver

  container.innerHTML = '<p class="campanha-aviso">Carregando a ficha…</p>';
  const p = await buscarPersonagemDaCampanha(campanhaId, personagemId);
  if (!p) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>Ficha não encontrada</h2>
        <p>Ela pode ter saído da mesa, ou você não é membro desta campanha.</p>
        <button class="btn btn-primary" onclick="navegar('campanhas')">Voltar</button>
      </div>`;
    return;
  }
  await renderSheet(container, personagemId, { personagem: p, campanhaId });
}
