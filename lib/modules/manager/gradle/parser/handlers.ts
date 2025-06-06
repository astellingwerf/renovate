import upath from 'upath';
import { logger } from '../../../../logger';
import { getSiblingFileName } from '../../../../util/fs';
import { regEx } from '../../../../util/regex';
import { parseUrl } from '../../../../util/url';
import type { PackageDependency } from '../../types';
import type { parseGradle as parseGradleCallback } from '../parser';
import type {
  ContentDescriptorMatcher,
  ContentDescriptorSpec,
  Ctx,
  GradleManagerData,
} from '../types';
import { isDependencyString, parseDependencyString } from '../utils';
import {
  GRADLE_PLUGINS,
  GRADLE_TEST_SUITES,
  findVariable,
  interpolateString,
  loadFromTokenMap,
} from './common';

// needed to break circular dependency
let parseGradle: typeof parseGradleCallback;
export function setParseGradleFunc(func: typeof parseGradleCallback): void {
  parseGradle = func;
}

export function handleAssignment(ctx: Ctx): Ctx {
  const key = loadFromTokenMap(ctx, 'keyToken')[0].value;
  const valTokens = loadFromTokenMap(ctx, 'valToken');

  if (valTokens.length > 1) {
    // = template string with multiple variables
    ctx.tokenMap.templateStringTokens = valTokens;
    handleDepString(ctx);
    delete ctx.tokenMap.templateStringTokens;
  } else if (valTokens[0].type === 'symbol') {
    // foo = bar || foo = "${bar}"
    const varData = findVariable(valTokens[0].value, ctx);
    if (varData) {
      ctx.globalVars[key] = { ...varData };
    }
  } else {
    // = string value
    const dep = parseDependencyString(valTokens[0].value);
    if (dep) {
      dep.sharedVariableName = key;
      dep.managerData = {
        fileReplacePosition: valTokens[0].offset + dep.depName!.length + 1,
        packageFile: ctx.packageFile,
      };
      ctx.deps.push(dep);
    }

    ctx.globalVars[key] = {
      key,
      value: valTokens[0].value,
      fileReplacePosition: valTokens[0].offset,
      packageFile: ctx.packageFile,
    };
  }

  return ctx;
}

export function handleDepString(ctx: Ctx): Ctx {
  const stringTokens = loadFromTokenMap(ctx, 'templateStringTokens');

  const templateString = interpolateString(stringTokens, ctx);
  if (!templateString) {
    return ctx;
  }

  const dep = parseDependencyString(templateString);
  if (!dep) {
    return ctx;
  }

  let packageFile: string | undefined;
  let fileReplacePosition: number | undefined;
  for (const token of stringTokens) {
    if (token.type === 'symbol') {
      const varData = findVariable(token.value, ctx);
      if (varData) {
        packageFile = varData.packageFile;
        fileReplacePosition = varData.fileReplacePosition;
        if (varData.value === dep.currentValue) {
          dep.managerData = { fileReplacePosition, packageFile };
          dep.sharedVariableName = varData.key;
        }
      }
    }
  }

  if (!dep.managerData) {
    const lastToken = stringTokens[stringTokens.length - 1];
    if (
      lastToken?.type === 'string-value' &&
      dep.currentValue &&
      lastToken.value.includes(dep.currentValue)
    ) {
      packageFile = ctx.packageFile;
      if (stringTokens.length === 1) {
        fileReplacePosition = lastToken.offset + dep.depName!.length + 1;
      } else {
        fileReplacePosition =
          lastToken.offset + lastToken.value.lastIndexOf(dep.currentValue);
      }
      delete dep.sharedVariableName;
    } else {
      dep.skipReason = 'contains-variable';
    }
    dep.managerData = { fileReplacePosition, packageFile };
  }

  ctx.deps.push(dep);

  return ctx;
}

export function handleKotlinShortNotationDep(ctx: Ctx): Ctx {
  const moduleNameTokens = loadFromTokenMap(ctx, 'artifactId');
  const versionTokens = loadFromTokenMap(ctx, 'version');

  const moduleName = interpolateString(moduleNameTokens, ctx);
  const versionValue = interpolateString(versionTokens, ctx);
  if (!moduleName || !versionValue) {
    return ctx;
  }

  const groupIdArtifactId = `org.jetbrains.kotlin:kotlin-${moduleName}`;
  const dep = parseDependencyString(`${groupIdArtifactId}:${versionValue}`);
  if (!dep) {
    return ctx;
  }

  dep.depName = moduleName;
  dep.packageName = groupIdArtifactId;
  dep.managerData = {
    fileReplacePosition: versionTokens[0].offset,
    packageFile: ctx.packageFile,
  };

  if (versionTokens.length > 1) {
    // = template string with multiple variables
    dep.skipReason = 'unspecified-version';
  } else if (versionTokens[0].type === 'symbol') {
    const varData = findVariable(versionTokens[0].value, ctx);
    if (varData) {
      dep.sharedVariableName = varData.key;
      dep.currentValue = varData.value;
      dep.managerData = {
        fileReplacePosition: varData.fileReplacePosition,
        packageFile: varData.packageFile,
      };
    }
  }

  ctx.deps.push(dep);

  return ctx;
}

export function handleLongFormDep(ctx: Ctx): Ctx {
  const groupIdTokens = loadFromTokenMap(ctx, 'groupId');
  const artifactIdTokens = loadFromTokenMap(ctx, 'artifactId');
  const versionTokens = loadFromTokenMap(ctx, 'version');

  const groupId = interpolateString(groupIdTokens, ctx);
  const artifactId = interpolateString(artifactIdTokens, ctx);
  const version = interpolateString(versionTokens, ctx);
  if (!groupId || !artifactId || !version) {
    return ctx;
  }

  // Special handling: 3 independent dependencies mismatched as groupId, artifactId, version
  if (
    isDependencyString(groupId) &&
    isDependencyString(artifactId) &&
    isDependencyString(version)
  ) {
    ctx.tokenMap.templateStringTokens = groupIdTokens;
    handleDepString(ctx);
    ctx.tokenMap.templateStringTokens = artifactIdTokens;
    handleDepString(ctx);
    ctx.tokenMap.templateStringTokens = versionTokens;
    handleDepString(ctx);

    return ctx;
  }

  const dep = parseDependencyString([groupId, artifactId, version].join(':'));
  if (!dep) {
    return ctx;
  }

  const methodName = ctx.tokenMap.methodName ?? null;
  if (versionTokens.length > 1) {
    // = template string with multiple variables
    dep.skipReason = 'unspecified-version';
  } else if (versionTokens[0].type === 'symbol') {
    const varData = findVariable(versionTokens[0].value, ctx);
    if (varData) {
      dep.sharedVariableName = varData.key;
      dep.managerData = {
        fileReplacePosition: varData.fileReplacePosition,
        packageFile: varData.packageFile,
      };
    }
  } else {
    // = string value
    if (methodName?.[0]?.value === 'dependencySet') {
      dep.sharedVariableName = `${groupId}:${version}`;
    }
    dep.managerData = {
      fileReplacePosition: versionTokens[0].offset,
      packageFile: ctx.packageFile,
    };
  }

  ctx.deps.push(dep);

  return ctx;
}

export function handlePlugin(ctx: Ctx): Ctx {
  const methodName = loadFromTokenMap(ctx, 'methodName')[0];
  const pluginName = loadFromTokenMap(ctx, 'pluginName')[0];
  const pluginVersion = loadFromTokenMap(ctx, 'version');

  const plugin = pluginName.value;
  const depName =
    methodName.value === 'kotlin' ? `org.jetbrains.kotlin.${plugin}` : plugin;
  const packageName = `${depName}:${depName}.gradle.plugin`;

  const dep: PackageDependency<GradleManagerData> = {
    depType: 'plugin',
    depName,
    packageName,
    commitMessageTopic: `plugin ${depName}`,
    currentValue: pluginVersion[0].value,
    managerData: {
      fileReplacePosition: pluginVersion[0].offset,
      packageFile: ctx.packageFile,
    },
  };

  if (pluginVersion.length > 1) {
    // = template string with multiple variables
    dep.skipReason = 'unspecified-version';
  } else if (pluginVersion[0].type === 'symbol') {
    const varData = findVariable(pluginVersion[0].value, ctx);
    if (varData) {
      dep.sharedVariableName = varData.key;
      dep.currentValue = varData.value;
      dep.managerData = {
        fileReplacePosition: varData.fileReplacePosition,
        packageFile: varData.packageFile,
      };
    } else {
      dep.skipReason = 'unspecified-version';
    }
  }

  ctx.deps.push(dep);

  return ctx;
}

function isValidContentDescriptorRegex(
  fieldName: string,
  pattern: string,
): boolean {
  try {
    regEx(pattern);
  } catch {
    logger.debug(
      `Skipping content descriptor with unsupported regExp pattern for ${fieldName}: ${pattern}`,
    );
    return false;
  }

  return true;
}

export function handleRegistryContent(ctx: Ctx): Ctx {
  const methodName = loadFromTokenMap(ctx, 'methodName')[0].value;
  let groupId = loadFromTokenMap(ctx, 'groupId')[0].value;

  let matcher: ContentDescriptorMatcher = 'simple';
  if (methodName.includes('Regex')) {
    matcher = 'regex';
    groupId = `^${groupId}$`.replaceAll('\\\\', '\\');
    if (!isValidContentDescriptorRegex('group', groupId)) {
      return ctx;
    }
  } else if (methodName.includes('AndSubgroups')) {
    matcher = 'subgroup';
  }

  const mode = methodName.startsWith('include') ? 'include' : 'exclude';
  const spec: ContentDescriptorSpec = { mode, matcher, groupId };

  if (methodName.includes('Module') || methodName.includes('Version')) {
    spec.artifactId = loadFromTokenMap(ctx, 'artifactId')[0].value;
    if (matcher === 'regex') {
      spec.artifactId = `^${spec.artifactId}$`.replaceAll('\\\\', '\\');
      if (!isValidContentDescriptorRegex('module', spec.artifactId)) {
        return ctx;
      }
    }
  }

  if (methodName.includes('Version')) {
    spec.version = loadFromTokenMap(ctx, 'version')[0].value;
    if (matcher === 'regex') {
      spec.version = `^${spec.version}$`.replaceAll('\\\\', '\\');
      if (!isValidContentDescriptorRegex('version', spec.version)) {
        return ctx;
      }
    }
  }

  ctx.tmpRegistryContent.push(spec);

  return ctx;
}

function isPluginRegistry(ctx: Ctx): boolean {
  if (ctx.tokenMap.registryScope) {
    const registryScope = loadFromTokenMap(ctx, 'registryScope')[0].value;
    return registryScope === 'pluginManagement';
  }

  return false;
}

function isExclusiveRegistry(ctx: Ctx): boolean {
  if (ctx.tokenMap.registryType) {
    const registryType = loadFromTokenMap(ctx, 'registryType')[0].value;
    return registryType === 'exclusiveContent';
  }

  return false;
}

export function handleRegistryUrl(ctx: Ctx): Ctx {
  let localVariables = ctx.globalVars;

  if (ctx.tokenMap.name) {
    const nameTokens = loadFromTokenMap(ctx, 'name');
    const nameValue = interpolateString(nameTokens, ctx, localVariables);
    if (nameValue) {
      localVariables = {
        ...localVariables,
        name: {
          key: 'name',
          value: nameValue,
        },
      };
    }
  }

  let registryUrl = interpolateString(
    loadFromTokenMap(ctx, 'registryUrl'),
    ctx,
    localVariables,
  );
  if (registryUrl) {
    registryUrl = registryUrl.replace(regEx(/\\/g), '');
    const url = parseUrl(registryUrl);
    if (url?.host && url.protocol) {
      ctx.registryUrls.push({
        registryUrl,
        registryType: isExclusiveRegistry(ctx) ? 'exclusive' : 'regular',
        scope: isPluginRegistry(ctx) ? 'plugin' : 'dep',
        content: ctx.tmpRegistryContent,
      });
    }
  }

  return ctx;
}

export function handleLibraryDep(ctx: Ctx): Ctx {
  const groupIdTokens = loadFromTokenMap(ctx, 'groupId');
  const artifactIdTokens = loadFromTokenMap(ctx, 'artifactId');

  const groupId = interpolateString(groupIdTokens, ctx);
  const artifactId = interpolateString(artifactIdTokens, ctx);
  if (!groupId || !artifactId) {
    return ctx;
  }

  const aliasToken = loadFromTokenMap(ctx, 'alias')[0];
  const key = `libs.${aliasToken.value.replace(regEx(/[-_]/g), '.')}`;

  ctx.globalVars[key] = {
    key,
    value: `${groupId}:${artifactId}`,
    fileReplacePosition: aliasToken.offset,
    packageFile: ctx.packageFile,
  };

  if (ctx.tokenMap.version) {
    const version = interpolateString(loadFromTokenMap(ctx, 'version'), ctx);
    if (version) {
      handleLongFormDep(ctx);
    }
  }

  return ctx;
}

export function handleApplyFrom(ctx: Ctx): Ctx {
  let scriptFile = interpolateString(loadFromTokenMap(ctx, 'scriptFile'), ctx);
  if (!scriptFile) {
    return ctx;
  }

  if (ctx.tokenMap.parentPath) {
    const parentPath = interpolateString(
      loadFromTokenMap(ctx, 'parentPath'),
      ctx,
    );
    if (parentPath && scriptFile) {
      scriptFile = upath.join(parentPath, scriptFile);
    }
  }

  if (ctx.recursionDepth > 2) {
    logger.debug(`Max recursion depth reached in script file: ${scriptFile}`);
    return ctx;
  }

  if (!regEx(/\.gradle(\.kts)?$/).test(scriptFile)) {
    logger.debug({ scriptFile }, `Only Gradle files can be included`);
    return ctx;
  }

  const scriptFilePath = getSiblingFileName(ctx.packageFile, scriptFile);
  if (!ctx.fileContents[scriptFilePath]) {
    logger.debug(`Failed to process included Gradle file ${scriptFilePath}`);
    return ctx;
  }

  const matchResult = parseGradle(
    // TODO #22198
    ctx.fileContents[scriptFilePath],
    ctx.globalVars,
    scriptFilePath,
    ctx.fileContents,
    ctx.recursionDepth + 1,
  );

  ctx.deps.push(...matchResult.deps);
  ctx.globalVars = { ...ctx.globalVars, ...matchResult.vars };
  ctx.registryUrls.push(...matchResult.urls);

  return ctx;
}

export function handleImplicitDep(ctx: Ctx): Ctx {
  const implicitDepName = loadFromTokenMap(ctx, 'implicitDepName')[0].value;
  const versionTokens = loadFromTokenMap(ctx, 'version');
  const versionValue = interpolateString(versionTokens, ctx);
  if (!versionValue) {
    return ctx;
  }

  const isImplicitGradlePlugin = implicitDepName in GRADLE_PLUGINS;
  const groupIdArtifactId = isImplicitGradlePlugin
    ? GRADLE_PLUGINS[implicitDepName as keyof typeof GRADLE_PLUGINS][1]
    : GRADLE_TEST_SUITES[implicitDepName as keyof typeof GRADLE_TEST_SUITES];

  const dep = parseDependencyString(`${groupIdArtifactId}:${versionValue}`);
  if (!dep) {
    return ctx;
  }

  dep.depName = implicitDepName;
  dep.packageName = groupIdArtifactId;
  dep.managerData = {
    fileReplacePosition: versionTokens[0].offset,
    packageFile: ctx.packageFile,
  };

  if (versionTokens.length > 1) {
    // = template string with multiple variables
    dep.skipReason = 'unspecified-version';
  } else if (versionTokens[0].type === 'symbol') {
    const varData = findVariable(versionTokens[0].value, ctx);
    if (varData) {
      dep.sharedVariableName = varData.key;
      dep.currentValue = varData.value;
      dep.managerData = {
        fileReplacePosition: varData.fileReplacePosition,
        packageFile: varData.packageFile,
      };
    }
  }

  ctx.deps.push(dep);

  return ctx;
}
