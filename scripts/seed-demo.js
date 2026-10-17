'use strict';

// Carrega os dados de TESTE no banco local (ver src/test-data.js).
// NUNCA rode isto no sistema de verdade: ele lança estoque com custo de exemplo.

const { openDatabase } = require('../src/db');
const { seedTestData } = require('../src/test-data');

seedTestData(openDatabase());
