// ============================================================
// Painel "Meu Turno" (FAB ⚔️): mostra o que o personagem pode fazer com a
// Ação, a Ação Bônus, a Reação e de graça, junta a referência das 12 ações
// do livro com o que a ficha concede, e marca o gasto na CONFIRMAÇÃO de
// cada opção -- não há modo de combate para ligar antes.
// ============================================================
import { test, expect } from '@playwright/test';
import { ATRIBUTOS_REGRAS, abrirFicha, assentar, personagemSalvo } from './helpers-regras.mjs';

// Clérigo: Palavra Curativa é Ação Bônus e Bola de Fogo é Ação no acervo --
// as duas faixas saem povoadas com dado real, sem depender de detecção de
// texto em característica.
const CLERIGO = {
  classe: 'Clérigo', nivel: 5, xp: 6500, atributos: ATRIBUTOS_REGRAS,
  subclasse: 'Domínio da Vida',
  magias_preparadas: [
    { nome: 'Palavra Curativa', circulo: 1, classe: 'Clérigo' },
    { nome: 'Curar Ferimentos', circulo: 1, classe: 'Clérigo' },
  ],
};

test('painel Meu Turno: o FAB abre o painel com as faixas e a referência do livro', async ({ context }) => {
  const { page, erros } = await abrirFicha(context, CLERIGO, 'regras-acoes-turno-abre');
  await assentar(page).catch(() => {});

  // Clique real no gatilho novo.
  await page.click('#fab-toggle-acoes');
  await expect(page.locator('#modal-titulo')).toHaveText('Meu Turno');

  const corpo = page.locator('#modal-corpo');
  // As quatro faixas da economia de ações.
  await expect(corpo.locator('.acao-faixa')).toHaveCount(4);
  await expect(corpo).toContainText('Ação Bônus');
  await expect(corpo).toContainText('Reação');

  // Referência do livro: as ações que o jogador novo mais esquece.
  await expect(corpo).toContainText('Esquivar');
  await expect(corpo).toContainText('Desengajar');
  await expect(corpo).toContainText('Ajudar');

  // Derivado da ficha: Palavra Curativa entra como Ação Bônus, pelo
  // tempo_conjuracao do acervo.
  await expect(corpo.locator('.acao-card', { hasText: 'Palavra Curativa' })).toHaveCount(1);

  expect(erros, `erros de console/página: ${erros.join('; ')}`).toEqual([]);
});

test('painel Meu Turno: clicar num card abre o popup com a descrição, não expande no card', async ({ context }) => {
  const { page, erros } = await abrirFicha(context, CLERIGO, 'regras-acoes-turno-popup');
  await assentar(page).catch(() => {});

  await page.click('#fab-toggle-acoes');
  await page.locator('.acao-card', { hasText: 'Esquivar' }).first().click();

  // Sub-modal empilhado por cima do painel, com o texto do livro.
  const sub = page.locator('.sub-modal-overlay').last();
  await expect(sub).toBeVisible();
  await expect(sub).toContainText('Desvantagem');

  expect(erros, `erros de console/página: ${erros.join('; ')}`).toEqual([]);
});

test('painel Meu Turno: confirmar a opção marca a Ação como gasta e Novo turno devolve', async ({ context }) => {
  const { page, erros } = await abrirFicha(context, CLERIGO, 'regras-acoes-turno-confirmar');
  await assentar(page).catch(() => {});

  await page.click('#fab-toggle-acoes');
  // Não existe mais modo para ligar antes: nem o botão, nem o "Usei" por
  // faixa. O gasto vem da confirmação de cada opção.
  await expect(page.locator('#btn-modo-combate')).toHaveCount(0);
  await expect(page.locator('[data-marcar-faixa]')).toHaveCount(0);
  await expect(page.locator('#btn-passar-turno')).toBeVisible();

  // Clicar na opção abre o popup com o custo e o botão de confirmar.
  await page.locator('.acao-card', { hasText: 'Esquivar' }).first().click();
  const sub = page.locator('.sub-modal-overlay').last();
  await expect(sub.locator('.acao-pop-custo')).toContainText('Ação');
  await sub.locator('[data-acao-confirmar]').click();

  // Confirmado: a faixa fica marcada como gasta.
  await expect(page.locator('.acao-faixa').first()).toHaveClass(/acao-faixa-gasta/);

  // Novo turno devolve a Ação.
  await page.click('#btn-passar-turno');
  await expect(page.locator('.acao-faixa').first()).not.toHaveClass(/acao-faixa-gasta/);

  expect(erros, `erros de console/página: ${erros.join('; ')}`).toEqual([]);
});

test('painel Meu Turno: confirmar uma magia gasta o espaço, e o que é grátis não pede confirmação', async ({ context }) => {
  const { page, erros } = await abrirFicha(context, CLERIGO, 'regras-acoes-turno-espaco');
  await assentar(page).catch(() => {});

  await page.click('#fab-toggle-acoes');
  // Palavra Curativa é Ação Bônus de 1º círculo: o popup oferece de qual
  // reserva gastar, com o 1º círculo como primeira sugestão.
  await page.locator('.acao-card', { hasText: 'Palavra Curativa' }).first().click();
  const sub = page.locator('.sub-modal-overlay').last();
  await expect(sub.locator('[data-acao-espaco]').first()).toContainText('1º círculo');
  await expect(sub.locator('.acao-pop-custo')).toContainText('espaço de magia');
  await sub.locator('[data-acao-confirmar]').click();

  const salvo = await personagemSalvo(page);
  expect(salvo.espacos_magia.conjuracao['1']).toBe(1);
  expect(salvo.turno.bonus_usada).toBe(true);

  // Movimento é grátis: o popup informa e não oferece confirmação.
  await page.locator('.acao-card', { hasText: 'Mover' }).first().click();
  const livre = page.locator('.sub-modal-overlay').last();
  await expect(livre.locator('.acao-pop-custo')).toContainText('Grátis');
  await expect(livre.locator('[data-acao-confirmar]')).toHaveCount(0);

  expect(erros, `erros de console/página: ${erros.join('; ')}`).toEqual([]);
});

test('painel Meu Turno: condição Incapacitado bloqueia as três faixas', async ({ context }) => {
  const { page, erros } = await abrirFicha(context,
    { ...CLERIGO, condicoes: ['Incapacitado'] }, 'regras-acoes-turno-condicao');
  await assentar(page).catch(() => {});

  await page.click('#fab-toggle-acoes');
  const corpo = page.locator('#modal-corpo');

  // O aviso explica por que, com o texto da condição.
  await expect(corpo.locator('.painel-turno-condicoes')).toContainText('Incapacitado');
  // Ação, Ação Bônus e Reação bloqueadas; a faixa de movimento/grátis não.
  await expect(corpo.locator('.acao-faixa-bloqueada')).toHaveCount(3);

  expect(erros, `erros de console/página: ${erros.join('; ')}`).toEqual([]);
});
