import type {
  GetReleasesConfig,
  PostprocessReleaseConfig,
  PostprocessReleaseResult,
  Release,
  ReleaseResult,
} from '../../../../modules/datasource';
import * as _datasourceCommon from '../../../../modules/datasource/common';
import { Datasource } from '../../../../modules/datasource/datasource';
import * as allVersioning from '../../../../modules/versioning';
import { clone } from '../../../../util/clone';
import * as _dateUtil from '../../../../util/date';
import * as _mergeConfidence from '../../../../util/merge-confidence';
import { toMs } from '../../../../util/pretty-time';
import type { Timestamp } from '../../../../util/timestamp';
import { filterInternalChecks } from './filter-checks';
import type { LookupUpdateConfig, UpdateResult } from './types';

vi.mock('../../../../util/date');
const dateUtil = vi.mocked(_dateUtil);

vi.mock('../../../../util/merge-confidence');
const mergeConfidence = vi.mocked(_mergeConfidence);

vi.mock('../../../../modules/datasource/common');
const { getDatasourceFor } = vi.mocked(_datasourceCommon);

class DummyDatasource extends Datasource {
  constructor() {
    super('some-datasource');
  }

  override getReleases(_: GetReleasesConfig): Promise<ReleaseResult | null> {
    return Promise.resolve(null);
  }
}

let config: Partial<LookupUpdateConfig & UpdateResult>;

const versioning = allVersioning.get('semver');

const releases: Release[] = [
  {
    version: '1.0.1',
    releaseTimestamp: '2021-01-01T00:00:01.000Z' as Timestamp,
  },
  {
    version: '1.0.2',
    releaseTimestamp: '2021-01-03T00:00:00.000Z' as Timestamp,
  },
  {
    version: '1.0.3',
    releaseTimestamp: '2021-01-05T00:00:00.000Z' as Timestamp,
  },
  {
    version: '1.0.4',
    releaseTimestamp: '2021-01-07T00:00:00.000Z' as Timestamp,
  },
];

describe('workers/repository/process/lookup/filter-checks', () => {
  let sortedReleases: Release[];

  beforeEach(() => {
    config = { currentVersion: '1.0.0' };
    sortedReleases = clone(releases);
    dateUtil.getElapsedMs.mockReturnValueOnce(toMs('3 days') ?? 0);
    dateUtil.getElapsedMs.mockReturnValueOnce(toMs('5 days') ?? 0);
    dateUtil.getElapsedMs.mockReturnValueOnce(toMs('7 days') ?? 0);
    dateUtil.getElapsedMs.mockReturnValueOnce(toMs('9 days') ?? 0);
  });

  describe('.filterInternalChecks()', () => {
    it('returns latest release if internalChecksFilter=none', async () => {
      config.internalChecksFilter = 'none';
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(0);
      expect(res.release?.version).toBe('1.0.4');
    });

    it('uses datasource-level interception mechanism', async () => {
      config.datasource = 'some-datasource';
      config.packageName = 'some-package';
      config.internalChecksFilter = 'strict';

      class SomeDatasource extends DummyDatasource {
        override postprocessRelease(
          _: PostprocessReleaseConfig,
          release: Release,
        ): Promise<PostprocessReleaseResult> {
          if (release.version !== '1.0.2') {
            return Promise.resolve('reject');
          }

          release.isStable = true;
          return Promise.resolve(release);
        }
      }
      getDatasourceFor.mockReturnValue(new SomeDatasource());

      const { release } = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );

      expect(release).toEqual({
        version: '1.0.2',
        releaseTimestamp: '2021-01-03T00:00:00.000Z',
        isStable: true,
      });
    });

    it('returns non-pending latest release if internalChecksFilter=flexible and none pass checks', async () => {
      config.internalChecksFilter = 'flexible';
      config.minimumReleaseAge = '10 days';
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(0);
      expect(res.release?.version).toBe('1.0.4');
    });

    it('returns pending latest release if internalChecksFilter=strict and none pass checks', async () => {
      config.internalChecksFilter = 'strict';
      config.minimumReleaseAge = '10 days';
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeTrue();
      expect(res.pendingReleases).toHaveLength(0);
      expect(res.release?.version).toBe('1.0.4');
    });

    it('returns non-latest release if internalChecksFilter=strict and some pass checks', async () => {
      config.internalChecksFilter = 'strict';
      config.minimumReleaseAge = '6 days';
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(2);
      expect(res.release?.version).toBe('1.0.2');
    });

    it('returns non-latest release if internalChecksFilter=flexible and some pass checks', async () => {
      config.internalChecksFilter = 'strict';
      config.minimumReleaseAge = '6 days';
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(2);
      expect(res.release?.version).toBe('1.0.2');
    });

    it('picks up minimumReleaseAge settings from hostRules', async () => {
      config.internalChecksFilter = 'strict';
      config.minimumReleaseAge = '6 days';
      config.packageRules = [
        { matchUpdateTypes: ['patch'], minimumReleaseAge: '1 day' },
      ];
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(0);
      expect(res.release?.version).toBe('1.0.4');
    });

    it('picks up minimumReleaseAge settings from updateType', async () => {
      config.internalChecksFilter = 'strict';
      config.patch = { minimumReleaseAge: '4 days' };
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(1);
      expect(res.release?.version).toBe('1.0.3');
    });

    it('picks up minimumConfidence settings from updateType', async () => {
      config.internalChecksFilter = 'strict';
      config.minimumConfidence = 'high';
      mergeConfidence.isActiveConfidenceLevel.mockReturnValue(true);
      mergeConfidence.satisfiesConfidenceLevel.mockReturnValueOnce(false);
      mergeConfidence.satisfiesConfidenceLevel.mockReturnValueOnce(false);
      mergeConfidence.satisfiesConfidenceLevel.mockReturnValueOnce(false);
      mergeConfidence.satisfiesConfidenceLevel.mockReturnValueOnce(true);
      const res = await filterInternalChecks(
        config,
        versioning,
        'patch',
        sortedReleases,
      );
      expect(res).toMatchSnapshot();
      expect(res.pendingChecks).toBeFalse();
      expect(res.pendingReleases).toHaveLength(3);
      expect(res.release?.version).toBe('1.0.1');
    });
  });
});
