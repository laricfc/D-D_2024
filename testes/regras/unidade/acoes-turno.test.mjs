// Economia de acoes do turno: classificacao de tempo de conjuracao,
// deteccao de custo em caracteristicas e limites por condicao.
// O modulo e puro (sem DOM, sem fetch), entao importa direto -- nao precisa
// do modulosApp() do harness, so da RAIZ para ler o acervo real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RAIZ } from './harness.mjs';

const R = await import(pathToFileURL(resolve(RAIZ, 'site/js/regras-acoes-turno.js')).href);
const indice = JSON.parse(readFileSync(resolve(RAIZ, 'dados/magias/_indice.json'), 'utf-8')).magias;

test('classificarTempoConjuracao: Acao Bonus e testada antes de Acao', () => {
  // "Acao Bonus" CONTEM "acao" -- a ordem errada classificaria toda magia
  // de bonus como Acao, que e o erro que mais estraga o painel.
  assert.equal(R.classificarTempoConjuracao('Ação Bônus'), 'bonus');
  assert.equal(R.classificarTempoConjuracao('Ação'), 'acao');
  assert.equal(R.classificarTempoConjuracao('Reação'), 'reacao');
});

test('classificarTempoConjuracao: caudas longas do livro continuam na faixa certa', () => {
  // Valores reais do acervo, com a clausula de gatilho grudada no custo.
  assert.equal(R.classificarTempoConjuracao(
    'Ação Bônus, que você realiza imediatamente após atingir uma criatura com uma arma Corpo a Corpo ou um Ataque Desarmado'), 'bonus');
  assert.equal(R.classificarTempoConjuracao(
    'Reação, que você executa quando é atingido por uma jogada de ataque ou é alvo da magia Mísseis Mágicos'), 'reacao');
});

test('classificarTempoConjuracao: "Ação ou Ritual" vale como Ação; o que leva minutos fica fora do turno', () => {
  // O ritual e a via lenta da MESMA magia -- em combate ela e uma Acao.
  assert.equal(R.classificarTempoConjuracao('Ação ou Ritual'), 'acao');
  // Sem alternativa de acao, nao cabe num turno.
  assert.equal(R.classificarTempoConjuracao('1 minuto ou Ritual'), 'ritual');
  assert.equal(R.classificarTempoConjuracao('10 minutos'), 'fora_de_combate');
  assert.equal(R.classificarTempoConjuracao('1 hora'), 'fora_de_combate');
});

test('classificarTempoConjuracao: sujeira de extracao do PDF nao vira faixa errada', () => {
  // Dois valores que existem MESMO no acervo hoje.
  assert.equal(R.classificarTempoConjuracao('1 ação'), 'acao');
  assert.equal(R.classificarTempoConjuracao('ama Ação'), 'acao');
});

test('acervo real: toda magia cai numa faixa conhecida, e as 24 de Ação Bônus são reconhecidas', () => {
  const faixasValidas = new Set(['acao', 'bonus', 'reacao', 'ritual', 'fora_de_combate']);
  for (const m of indice) {
    const faixa = R.classificarTempoConjuracao(m.tempo_conjuracao);
    assert.ok(faixasValidas.has(faixa), `${m.nome}: faixa inesperada ${faixa}`);
  }
  // O acervo tem exatamente 24 magias com "Ação Bônus" seco e mais 11 com
  // a clausula de gatilho grudada: as 35 tem de cair em 'bonus'.
  const bonus = indice.filter(m => R.classificarTempoConjuracao(m.tempo_conjuracao) === 'bonus');
  const comTextoBonus = indice.filter(m => /ção Bônus/i.test(m.tempo_conjuracao || ''));
  assert.equal(bonus.length, comTextoBonus.length,
    'toda magia cujo tempo menciona Ação Bônus tem de cair na faixa bonus');
  assert.ok(bonus.length >= 24, `esperava ao menos 24 magias de Ação Bônus, achei ${bonus.length}`);
});

test('custoAcaoDeTexto: a frase que ABRE anunciando o custo é reconhecida', () => {
  assert.equal(R.custoAcaoDeTexto('Como uma Ação Bônus, você pode dar um salto.'), 'bonus');
  assert.equal(R.custoAcaoDeTexto('Com uma Reação, você reduz o dano pela metade.'), 'reacao');
});

test('custoAcaoDeTexto: custo com verbo de uso na mesma frase é reconhecido', () => {
  assert.equal(R.custoAcaoDeTexto(
    'Você pode gastar 1 Ponto de Foco para realizar Torrente de Golpes como uma Ação Bônus.'), 'bonus');
  assert.equal(R.custoAcaoDeTexto(
    'Você pode usar sua Reação para desviar do projétil.'), 'reacao');
});

test('custoAcaoDeTexto: menção de passagem NÃO vira custo (o falso positivo que importa)', () => {
  // Texto no estilo de Foco do Monge: cita caracteristicas que SAO acao
  // bonus, mas a caracteristica descrita aqui nao custa nada.
  const focoDoMonge = 'Seu foco e treinamento marcial permitem que você aproveite uma reserva de energia. '
    + 'Essa energia é representada por Pontos de Foco.';
  assert.equal(R.custoAcaoDeTexto(focoDoMonge), null);
  assert.equal(R.custoAcaoDeTexto(''), null);
  assert.equal(R.custoAcaoDeTexto(null), null);
});

test('custoAcaoDeTexto: Ação Bônus na frase não é classificada como Ação', () => {
  // A frase contem "acao" dentro de "acao bonus" -- o balde 'acao' tem de
  // pular essa frase, senao a caracteristica entra nas DUAS faixas.
  assert.equal(R.custoAcaoDeTexto('Você pode usar uma Ação Bônus para se esconder.'), 'bonus');
});

test('limitesDoTurno: Incapacitado tira Ação, Bônus e Reação', () => {
  const lim = R.limitesDoTurno(['Incapacitado'], 0);
  assert.equal(lim.acao, true);
  assert.equal(lim.bonus, true);
  assert.equal(lim.reacao, true);
  assert.ok(lim.motivos.length > 0);
});

test('limitesDoTurno: Contido zera o movimento sem tirar a Ação', () => {
  const lim = R.limitesDoTurno(['Contido'], 0);
  assert.equal(lim.movimento, true);
  assert.equal(lim.acao, false);
});

test('limitesDoTurno: condição sem efeito na economia de ações não bloqueia nada', () => {
  // Envenenado da Desvantagem, mas nao tira acao -- o painel responde
  // "o que posso fazer", nao "com que bonus".
  const lim = R.limitesDoTurno(['Envenenado'], 0);
  assert.deepEqual(
    { acao: lim.acao, bonus: lim.bonus, reacao: lim.reacao, movimento: lim.movimento },
    { acao: false, bonus: false, reacao: false, movimento: false });
});

test('limitesDoTurno: entrada ausente ou inválida não lança', () => {
  for (const entrada of [undefined, null, 'texto', 42]) {
    const lim = R.limitesDoTurno(entrada, undefined);
    assert.equal(lim.acao, false);
  }
});

test('limitesDoTurno: Exaustão entra como aviso numérico', () => {
  const lim = R.limitesDoTurno([], 3);
  assert.ok(lim.motivos.some(m => m.includes('Exaustão 3')), lim.motivos.join(' | '));
});

test('magiasPorFaixaDeAcao: separa pelo acervo e descarta o que não cabe no turno', () => {
  const baldes = R.magiasPorFaixaDeAcao(
    // "Escudo Arcano" e o nome da magia no acervo pt-BR; "Escudo" sozinho e
    // o item de inventario, e nao esta no indice de magias.
    [{ nome: 'Palavra Curativa' }, { nome: 'Bola de Fogo' }, { nome: 'Escudo Arcano' }],
    indice);
  const nomes = (b) => b.map(m => m.nome);
  assert.ok(nomes(baldes.bonus).includes('Palavra Curativa'), 'Palavra Curativa é Ação Bônus');
  assert.ok(nomes(baldes.acao).includes('Bola de Fogo'), 'Bola de Fogo é Ação');
  assert.ok(nomes(baldes.reacao).includes('Escudo Arcano'), 'Escudo Arcano é Reação');
});

test('magiasPorFaixaDeAcao: magia preparada por duas classes aparece uma vez só', () => {
  const baldes = R.magiasPorFaixaDeAcao(
    [{ nome: 'Bola de Fogo', classe: 'Mago' }, { nome: 'Bola de Fogo', classe: 'Feiticeiro' }],
    indice);
  assert.equal(baldes.acao.filter(m => m.nome === 'Bola de Fogo').length, 1);
});

test('magiasPorFaixaDeAcao: nome fora do acervo é ignorado, sem lançar', () => {
  const baldes = R.magiasPorFaixaDeAcao([{ nome: 'Magia Que Não Existe' }], indice);
  assert.deepEqual([baldes.acao.length, baldes.bonus.length, baldes.reacao.length], [0, 0, 0]);
});

test('magiasPorFaixaDeAcao: entradas ausentes devolvem baldes vazios', () => {
  const baldes = R.magiasPorFaixaDeAcao(undefined, undefined);
  assert.deepEqual([baldes.acao.length, baldes.bonus.length, baldes.reacao.length], [0, 0, 0]);
});

test('turnoZerado: estado inicial tem as três faixas livres e nenhum modo de combate', () => {
  // Sem `em_combate`: o painel marca o gasto na confirmação da opção, não
  // num modo que o jogador liga antes. Um campo a mais aqui voltaria a
  // ligar/desligar a marcação pela ficha inteira.
  assert.deepEqual(R.turnoZerado(),
    { acao_usada: false, bonus_usada: false, reacao_usada: false });
});

test('escolhasDeEspaco: só reservas de círculo igual ou maior, e só com espaço livre', () => {
  // O livro deixa ampliar (conjurar num círculo maior), nunca reduzir.
  const reservas = [
    { fonte: 'conjuracao', circulo: 1, total: 4, usados: 4, disponiveis: 0 },
    { fonte: 'conjuracao', circulo: 2, total: 3, usados: 1, disponiveis: 2 },
    { fonte: 'conjuracao', circulo: 3, total: 2, usados: 0, disponiveis: 2 },
  ];
  const escolhas = R.escolhasDeEspaco(reservas, 2);
  assert.deepEqual(escolhas.map((e) => e.circulo), [2, 3]);

  // Círculo 1 esgotado some mesmo sendo o mínimo pedido.
  assert.deepEqual(R.escolhasDeEspaco(reservas, 1).map((e) => e.circulo), [2, 3]);
});

test('escolhasDeEspaco: o espaço comum vem antes do Pacto no mesmo círculo', () => {
  // Bruxo multiclasse: sugerir primeiro o de conjuração poupa o espaço de
  // pacto, que é mais escasso e volta em descanso curto.
  const reservas = [
    { fonte: 'pacto', circulo: 3, total: 2, usados: 0, disponiveis: 2 },
    { fonte: 'conjuracao', circulo: 3, total: 3, usados: 0, disponiveis: 3 },
  ];
  assert.deepEqual(R.escolhasDeEspaco(reservas, 3).map((e) => e.fonte), ['conjuracao', 'pacto']);
});

test('escolhasDeEspaco: truque não gasta espaço e entrada inválida não lança', () => {
  const reservas = [{ fonte: 'conjuracao', circulo: 1, total: 4, usados: 0, disponiveis: 4 }];
  assert.deepEqual(R.escolhasDeEspaco(reservas, 0), []);
  for (const entrada of [undefined, null, 'x', 42]) {
    assert.deepEqual(R.escolhasDeEspaco(entrada, 1), []);
  }
});
