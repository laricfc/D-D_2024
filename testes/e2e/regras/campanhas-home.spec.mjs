import { test, expect } from '@playwright/test';
import { abrirSite } from './helpers-regras.mjs';

test('campanhas ficam visíveis na home mesmo sem conta conectada', async ({ context }) => {
  const { page, erros } = await abrirSite(context, '#home');
  const secao = page.locator('.campanha-bloco');
  await expect(secao).toBeVisible();
  await expect(secao).toContainText('Campanhas');
  await expect(secao).toContainText('entre com o Google');
  await expect(secao.locator('details')).toHaveCount(0);
  expect(erros).toEqual([]);
});

test('rota de ficha de campanha mantém contexto de campanha e informa ausência', async ({ context }) => {
  const { page, erros } = await abrirSite(context, '#ficha/campanha/mesa/personagem');
  await expect(page.locator('#app-content')).toContainText('Ficha não encontrada');
  expect(erros).toEqual([]);
});

test('resumo da campanha calcula CA com armadura e escudo', async ({ context }) => {
  const { page } = await abrirSite(context, '#home');
  const resultado = await page.evaluate(async () => {
    const { resumirFicha } = await import('./js/pages/campanhas.js');
    return resumirFicha({
      classe: 'Guerreiro', nivel: 3, atributos: { destreza: 14 },
      inventario: [
        { tipo: 'armadura', equipado: true, dados: { categoria: 'Média', ca: '14 + Des (máx. 2)' } },
        { tipo: 'escudo', equipado: true },
      ],
    }).ca;
  });
  expect(resultado).toBe(18);
});

test.describe('com service worker', () => {
test.use({ serviceWorkers: 'allow' });
test('recarregar campanha aguarda a restauração da sessão', async ({ context }) => {
  await context.route('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: 'export const initializeApp = () => ({});',
  }));
  await context.route('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: `
      export const getAuth = () => ({});
      export const onAuthStateChanged = (auth, callback) => {
        setTimeout(() => callback(null), 20);
        setTimeout(() => callback({uid:'mestre', displayName:'Mestre'}), 250);
      };
      export const signInWithPopup = () => {}; export class GoogleAuthProvider {} export const signOut = () => {};
    `,
  }));
  await context.route('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js', (route) => route.fulfill({
    contentType: 'application/javascript', body: `
      export const getFirestore = () => ({});
      export const doc = (...args) => args;
      export const collection = (...args) => args;
      export const getDoc = async () => ({exists: () => true, data: () => ({nome:'Mesa de teste', mestre_uid:'mestre'})});
      export const getDocs = async () => ({docs: []});
      export const writeBatch = () => ({ set: () => {}, commit: async () => {} });
      export const onSnapshot = (ref, cb) => { cb({docs:[{id:'heroi',data:()=>({nome:'Luna',classe:'Guerreiro',nivel:4,dono_uid:'outro',pv_atual:18,pv_max:28,condicoes:['Caído']})}]}); return () => {}; };
    `,
  }));
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8802/site/#campanha/mesa/mestre');
  await expect(page.locator('#app-content')).toContainText('Mesa de teste');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('#app-content')).toContainText('Mesa de teste');
  await expect(page.locator('#app-content')).not.toContainText('Entre com o Google');
  await expect(page.locator('#campanha-mesa')).toContainText('18/28 PV');
  await page.locator('[data-remover-ficha="heroi"]').click();
  await expect(page.locator('.sub-modal-overlay').last().or(page.locator('#modal-overlay'))).toContainText('Luna');
  await page.locator('#btn-confirmar-remover-fichas').locator('..').getByRole('button', { name: 'Cancelar' }).click();
  await page.locator('#btn-remover-todas-fichas').click();
  await expect(page.locator('#btn-confirmar-remover-fichas')).toBeVisible();
  await page.locator('#btn-confirmar-remover-fichas').locator('..').getByRole('button', { name: 'Cancelar' }).click();
  await page.locator('[data-trocar-visao="jogador"]').click();
  const mesa = page.locator('#campanha-mesa');
  await expect(mesa).toContainText('Luna');
  await expect(mesa).toContainText('Guerreiro 4');
  await expect(mesa).not.toContainText('18/28 PV');
  await expect(mesa).not.toContainText('Caído');
  await expect(mesa.locator('[data-abrir-ficha]')).toHaveCount(0);
});
});
