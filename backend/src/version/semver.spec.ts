import { compareSemver, isStableVersion, parseSemver, versionFromTag } from './semver';

describe('semver', () => {
  describe('parseSemver', () => {
    it('解析合法的稳定版、预发布版和带构建元数据的版本', () => {
      expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null, build: null });
      expect(parseSemver('1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['beta', '1'], build: null });
      expect(parseSemver('2.3.4+build.5')).toEqual({ major: 2, minor: 3, patch: 4, prerelease: null, build: 'build.5' });
      expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: null, build: null });
    });

    it('拒绝非法版本：前导零、缺段、多余字符、空串与非字符串', () => {
      expect(parseSemver('01.2.3')).toBeNull();
      expect(parseSemver('1.2')).toBeNull();
      expect(parseSemver('1.2.3.4')).toBeNull();
      expect(parseSemver('v1.2.3')).toBeNull();
      expect(parseSemver(' 1.2.3')).toBeNull();
      expect(parseSemver('1.2.3-')).toBeNull();
      expect(parseSemver('')).toBeNull();
      expect(parseSemver(undefined as unknown as string)).toBeNull();
    });
  });

  describe('compareSemver', () => {
    it('相等返回 0（忽略构建元数据）', () => {
      expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
      expect(compareSemver('1.2.3+a', '1.2.3+b')).toBe(0);
    });

    it('按主/次/补丁位比较', () => {
      expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
      expect(compareSemver('1.3.0', '1.2.99')).toBe(1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
      expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    });

    it('预发布版本低于同版本号的正式版', () => {
      expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
      expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    });

    it('预发布标识符按 SemVer 规则比较', () => {
      expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
      expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
      expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1);
      expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    });

    it('任一入参非法返回 null，不隐式当作相等', () => {
      expect(compareSemver('1.2.3', 'not-a-version')).toBeNull();
      expect(compareSemver('bogus', '1.2.3')).toBeNull();
    });
  });

  describe('isStableVersion', () => {
    it('仅无预发布标识符的合法版本为稳定版', () => {
      expect(isStableVersion('1.0.0')).toBe(true);
      expect(isStableVersion('1.0.0-beta.1')).toBe(false);
      expect(isStableVersion('1.0.0+build')).toBe(true);
      expect(isStableVersion('garbage')).toBe(false);
    });
  });

  describe('versionFromTag', () => {
    it('从 vX.Y.Z tag 提取版本并拒绝非法 tag', () => {
      expect(versionFromTag('v1.2.3')).toBe('1.2.3');
      expect(versionFromTag('v1.0.0-beta.1')).toBe('1.0.0-beta.1');
      expect(versionFromTag('1.2.3')).toBeNull();
      expect(versionFromTag('vX.Y.Z')).toBeNull();
      expect(versionFromTag('release-1.2.3')).toBeNull();
      expect(versionFromTag('v')).toBeNull();
    });
  });
});
