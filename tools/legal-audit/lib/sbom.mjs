// CycloneDX 1.6 SBOM (JSON) from `cargo metadata --locked` + Cargo.lock + npm lockfiles.
//   * one component per crate (all dependency kinds, workspace members included) and per npm package (`packages` of
//     lockfileVersion 2/3), de-duplicated by purl across lockfiles
//   * purl, version and licence; hashes: Cargo.lock `checksum` (SHA-256) for registry crates, npm `integrity`
//     (usually SHA-512) for npm packages. Workspace crates and git/path crates have no registry checksum => no hash.
//   * dependency graph from the cargo resolve graph and from npm lockfile `dependencies` (node resolution)
//   * deterministic: components sorted by bom-ref, serialNumber derived from the content, timestamp = ctx.now
import { createHash } from 'node:crypto';
import { cargoPurl, integrityHashes, normaliseCargoLicense, npmPurl, resolveNpmDependency } from './inventory.mjs';
import { isSpdxExpression } from './spdx.mjs';

function licenseChoice(raw, licenseFile) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expr = raw.trim();
    if (isSpdxExpression(expr)) return [{ expression: expr }];
    return [{ license: { name: expr } }];
  }
  if (licenseFile) return [{ license: { name: `see license file: ${licenseFile}` } }];
  return undefined;
}

function serialFromContent(content) {
  const h = createHash('sha256').update(content).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const byRef = (a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : a['bom-ref'] > b['bom-ref'] ? 1 : 0);

/**
 * @param {object} p
 * @param {object|null} p.cargoMetadata   parsed `cargo metadata --format-version 1` (null when there is no Rust part)
 * @param {Array|null} p.cargoLock        parseCargoLock() result (checksums)
 * @param {Array<{rel:string, packages:object[]}>} p.npmLocks readNpmLock() results
 * @param {Date} p.now
 * @param {string} p.rootName             name of the product component
 * @param {string} [p.rootVersion]
 * @param {{name:string, version:string}} p.tool
 * @returns {{bom: object, counts: {cargo:number, npm:number}}}
 */
export function buildSbom({ cargoMetadata, cargoLock, npmLocks, now, rootName, rootVersion, tool }) {
  const components = new Map(); // bom-ref -> component
  const edges = new Map(); // bom-ref -> Set(bom-ref)
  const rootRef = `urn:recon:${rootName}`;
  const rootDeps = new Set();
  let cargoCount = 0;
  let npmCount = 0;

  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  if (cargoMetadata) {
    const checksums = new Map();
    for (const lp of cargoLock ?? []) if (lp.checksum) checksums.set(`${lp.name}@${lp.version}@${lp.source ?? ''}`, lp.checksum);
    const members = new Set(cargoMetadata.workspace_members);
    const refOf = new Map();
    for (const p of cargoMetadata.packages) {
      const purl = cargoPurl(p.name, p.version, p.source);
      refOf.set(p.id, purl);
      const checksum = checksums.get(`${p.name}@${p.version}@${p.source ?? ''}`);
      const comp = {
        type: 'library',
        'bom-ref': purl,
        name: p.name,
        version: p.version,
        purl,
      };
      const lic = licenseChoice(p.license ? normaliseCargoLicense(p.license) : null, p.license_file);
      if (lic) comp.licenses = lic;
      if (checksum && /^[0-9a-f]{64}$/.test(checksum)) comp.hashes = [{ alg: 'SHA-256', content: checksum }];
      if (members.has(p.id)) comp.properties = [{ name: 'recon:workspace-member', value: 'true' }];
      if (!components.has(purl)) {
        components.set(purl, comp);
        cargoCount++;
      }
      if (members.has(p.id)) rootDeps.add(purl);
    }
    for (const node of cargoMetadata.resolve?.nodes ?? []) {
      const from = refOf.get(node.id);
      if (!from) continue;
      for (const d of node.deps ?? []) {
        const to = refOf.get(d.pkg);
        if (to && to !== from) addEdge(from, to);
      }
    }
  }

  for (const lock of npmLocks) {
    const paths = new Set(lock.packages.map((p) => p.path));
    const refByPath = new Map();
    for (const p of lock.packages) {
      if (!p.version) continue;
      const purl = npmPurl(p.name, p.version);
      refByPath.set(p.path, purl);
      let comp = components.get(purl);
      if (!comp) {
        comp = { type: 'library', 'bom-ref': purl, name: p.name, version: p.version, purl };
        if (p.name.startsWith('@')) {
          const slash = p.name.indexOf('/');
          comp.group = p.name.slice(0, slash);
          comp.name = p.name.slice(slash + 1);
        }
        const lic = licenseChoice(p.license, null);
        if (lic) comp.licenses = lic;
        const hashes = integrityHashes(p.integrity);
        if (hashes.length > 0) comp.hashes = hashes.slice(0, 1);
        if (typeof p.resolved === 'string' && /^https?:\/\//.test(p.resolved)) {
          comp.externalReferences = [{ type: 'distribution', url: p.resolved }];
        }
        comp.properties = [];
        components.set(purl, comp);
        npmCount++;
      }
      comp.properties.push({ name: 'recon:lockfile', value: lock.rel });
      if (p.dev) comp.properties.push({ name: 'recon:npm-dev', value: 'true' });
      if (p.optional) comp.properties.push({ name: 'recon:npm-optional', value: 'true' });
    }
    for (const p of lock.packages) {
      const from = refByPath.get(p.path);
      if (!from) continue;
      for (const dep of Object.keys(p.dependencies)) {
        const target = resolveNpmDependency(paths, p.path, dep);
        const to = target ? refByPath.get(target) : undefined;
        if (to && to !== from) addEdge(from, to);
      }
    }
    // the product depends on what each lockfile's own package declares
    for (const dep of lock.rootDependencies ?? []) {
      const target = resolveNpmDependency(paths, '', dep);
      const ref = target ? refByPath.get(target) : undefined;
      if (ref) rootDeps.add(ref);
    }
  }

  const sorted = [...components.values()].sort(byRef);
  for (const c of sorted) if (c.properties && c.properties.length === 0) delete c.properties;
  const dependencies = [
    { ref: rootRef, dependsOn: [...rootDeps].sort() },
    ...sorted.map((c) => ({ ref: c['bom-ref'], dependsOn: [...(edges.get(c['bom-ref']) ?? [])].sort() })),
  ];

  const body = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: { components: [{ type: 'application', name: tool.name, version: tool.version }] },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootName,
        ...(rootVersion ? { version: rootVersion } : {}),
      },
    },
    components: sorted,
    dependencies,
  };
  const bom = { ...body, serialNumber: serialFromContent(JSON.stringify(body)) };
  // CycloneDX documents conventionally start with bomFormat/specVersion/serialNumber/version.
  const ordered = {
    bomFormat: bom.bomFormat,
    specVersion: bom.specVersion,
    serialNumber: bom.serialNumber,
    version: bom.version,
    metadata: bom.metadata,
    components: bom.components,
    dependencies: bom.dependencies,
  };
  return { bom: ordered, counts: { cargo: cargoCount, npm: npmCount } };
}
