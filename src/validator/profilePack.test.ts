import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadProfilePack, PROFILE_PACK_INPUTS, type ProfilePackInput } from './profilePack.js';

// fhir_igs/ está en .gitignore (los IG no se redistribuyen): en un checkout limpio/CI los tests
// contra el artefacto real se omiten en vez de fallar. Bajar el pack: ver README.
const hasPack = (id: 'cl-core' | 'co-core'): boolean => existsSync(PROFILE_PACK_INPUTS[id].source.path);

const tmp = () => mkdtempSync(join(tmpdir(), 'pack-'));

test('modo npm-package: confirma nombre/versión y lista SD desde .index.json', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake.pkg', version: '9.9.9', fhirVersions: ['4.0.1'] }));
  writeFileSync(
    join(dir, '.index.json'),
    JSON.stringify({ files: [
      { filename: 'StructureDefinition-FakePatient.json', resourceType: 'StructureDefinition', id: 'FakePatient' },
      { filename: 'CodeSystem-X.json', resourceType: 'CodeSystem', id: 'X' },
    ] }),
  );
  const input: ProfilePackInput = { id: 'fake', country: 'ZZ', fhirVersion: '4.0.1', source: { kind: 'npm-package', packageName: 'fake.pkg', packageVersion: '9.9.9', path: dir } };
  const pack = loadProfilePack(input);
  expect(pack.structureDefinitions).toEqual(['FakePatient']); // solo SD, no el CodeSystem
});

test('modo npm-package: nombre/versión que no calzan → PROFILE_PACK_MISMATCH', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'otro.pkg', version: '1.0.0', fhirVersions: ['4.0.1'] }));
  const input: ProfilePackInput = { id: 'fake', country: 'ZZ', fhirVersion: '4.0.1', source: { kind: 'npm-package', packageName: 'fake.pkg', packageVersion: '9.9.9', path: dir } };
  expect(() => loadProfilePack(input)).toThrowError(expect.objectContaining({ code: 'PROFILE_PACK_MISMATCH' }));
});

test('modo loose-json: lista SD desde nombres de archivo, ignora el resto', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'StructureDefinition-FooCO.json'), '{}');
  writeFileSync(join(dir, 'StructureDefinition-BarCO.json'), '{}');
  writeFileSync(join(dir, 'ImplementationGuide-x.json'), '{}');
  writeFileSync(join(dir, 'spec.internals'), 'binario');
  const input: ProfilePackInput = { id: 'fake', country: 'ZZ', fhirVersion: '4.0.1', source: { kind: 'loose-json', path: dir, note: 'sin manifiesto' } };
  const pack = loadProfilePack(input);
  expect(pack.structureDefinitions).toEqual(['BarCO', 'FooCO']);
});

test.skipIf(!hasPack('cl-core'))('pack real cl-core (npm-package) carga y confirma metadatos del artefacto', () => {
  const pack = loadProfilePack(PROFILE_PACK_INPUTS['cl-core']);
  expect(pack.country).toBe('CL');
  expect(pack.source.kind).toBe('npm-package');
  expect(pack.structureDefinitions).toContain('CorePacienteCl');
  expect(pack.structureDefinitions).toContain('CoreObservacionCL'); // perfil de Observation desde 1.9.x
});

test.skipIf(!hasPack('co-core'))('pack real co-core (loose-json) carga con procedencia declarada de la versión', () => {
  const input = PROFILE_PACK_INPUTS['co-core'];
  const pack = loadProfilePack(input);
  expect(pack.country).toBe('CO');
  if (input.source.kind !== 'loose-json') throw new Error('co-core debe ser loose-json');
  expect(input.source.declaredPackageVersion).toBe('0.1.0');
  expect(input.source.note).toMatch(/no publica package\.json/);
  expect(pack.structureDefinitions).toContain('PatientCO');
});
