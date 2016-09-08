var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var level = require('level');
var lodash = require('lodash');
var mkdirp = require('mkdirp');
var Tapable = require('tapable');

var Promise = require('bluebird');

var envHash;
try {
  envHash = require('env-hash');
  envHash = envHash.default || envHash;
}
catch (_) {
  envHash = function() {
    return Promise.resolve('');
  };
}

var AsyncDependenciesBlock = require('webpack/lib/AsyncDependenciesBlock');
var ConstDependency = require('webpack/lib/dependencies/ConstDependency');
var ContextDependency = require('webpack/lib/dependencies/ContextDependency');
var NormalModule = require('webpack/lib/NormalModule');
var NullDependencyTemplate = require('webpack/lib/dependencies/NullDependencyTemplate');
var NullFactory = require('webpack/lib/NullFactory');
var SingleEntryDependency = require('webpack/lib/dependencies/SingleEntryDependency');

var HarmonyImportDependency, HarmonyImportSpecifierDependency, HarmonyExportImportedSpecifierDependency;

try {
  HarmonyImportDependency = require('webpack/lib/dependencies/HarmonyImportDependency');
  HarmonyImportSpecifierDependency = require('webpack/lib/dependencies/HarmonyImportSpecifierDependency');
  HarmonyExportImportedSpecifierDependency = require('webpack/lib/dependencies/HarmonyExportImportedSpecifierDependency');
}
catch (_) {}

var HardModuleDependency = require('./lib/dependencies').HardModuleDependency;
var HardContextDependency = require('./lib/dependencies').HardContextDependency;
var HardNullDependency = require('./lib/dependencies').HardNullDependency;
var HardHarmonyExportDependency = require('./lib/dependencies').HardHarmonyExportDependency;
var HardHarmonyImportDependency =
require('./lib/dependencies').HardHarmonyImportDependency;
var HardHarmonyImportSpecifierDependency =
require('./lib/dependencies').HardHarmonyImportSpecifierDependency;
var HardHarmonyExportImportedSpecifierDependency = require('./lib/dependencies').HardHarmonyExportImportedSpecifierDependency;

var FileSerializer = require('./lib/cache-serializers').FileSerializer;
var HardModule = require('./lib/hard-module');
var LevelDbSerializer = require('./lib/cache-serializers').LevelDbSerializer;
var makeDevtoolOptions = require('./lib/devtool-options');

function requestHash(request) {
  return crypto.createHash('sha1').update(request).digest().hexSlice();
}

var promisify = Promise.promisify;

var fsReadFile = Promise.promisify(fs.readFile, {context: fs});
var fsStat = Promise.promisify(fs.stat, {context: fs});
var fsWriteFile = Promise.promisify(fs.writeFile, {context: fs});

function serializeDependencies(deps) {
  return deps
  .map(function(dep) {
    return this.applyPluginsWaterfall('freeze-dependency', null, dep);
  }, this)
  .filter(Boolean);
  // .filter(function(req) {
  //   return req.request || req.constDependency || req.harmonyExport || req.harmonyImportSpecifier || req.harmonyExportImportedSpecifier;
  // });
}
function serializeVariables(vars) {
  return vars.map(function(variable) {
    return {
      name: variable.name,
      expression: variable.expression,
      dependencies: serializeDependencies.call(this, variable.dependencies),
    }
  }, this);
}
function serializeBlocks(blocks) {
  return blocks.map(function(block) {
    return {
      async: block instanceof AsyncDependenciesBlock,
      name: block.chunkName,
      dependencies: serializeDependencies.call(this, block.dependencies),
      variables: serializeVariables.call(this, block.variables),
      blocks: serializeBlocks.call(this, block.blocks),
    };
  }, this);
}
function serializeHashContent(module) {
  var content = [];
  module.updateHash({
    update: function(str) {
      content.push(str);
    },
  });
  return content.join('');
}

// function AssetCache() {
//
// }
//
// function ModuleCache() {
//   this.cache = {};
//   this.serializer = null;
// }
//
// ModuleCache.prototype.get = function(identifier) {
//
// };
//
// ModuleCache.prototype.save = function(modules) {
//
// };

function DependencySerializePlugin() {
}

DependencySerializePlugin.prototype.apply = function(hardSource) {
  hardSource.plugin('freeze-dependency', function(carry, dep) {
    if (dep instanceof ContextDependency) {
      return {
        contextDependency: dep instanceof ContextDependency,
        contextCritical: dep.critical,
        request: dep.request,
        recursive: dep.recursive,
        regExp: dep.regExp ? dep.regExp.source : null,
        loc: dep.loc,
      };
    }
    if (dep instanceof ConstDependency) {
      return {
        constDependency: dep instanceof ConstDependency,
      };
    }
    if (dep.request) {
      return {
        request: dep.request,
      };
    }
    return carry;
  });
};

function DependencyThawPlugin() {
}

DependencyThawPlugin.prototype.apply = function(hardSource) {
  hardSource.plugin('thaw-dependency', function(carry, req) {
    if (req.contextDependency) {
      var dep = new HardContextDependency(req.request, req.recursive, req.regExp ? new RegExp(req.regExp) : null);
      dep.critical = req.contextCritical;
      dep.loc = req.loc;
      return dep;
    }
    if (req.constDependency) {
      return new HardNullDependency();
    }
    return new HardModuleDependency(req.request);
  });
};

function HarmonyDependencySerializePlugin() {
}

HarmonyDependencySerializePlugin.prototype.apply = function(hardSource) {
  if (typeof HarmonyImportDependency === 'undefined') {
    return;
  }

  hardSource.plugin('freeze-dependency', function(carry, dep) {
    if (dep instanceof HarmonyImportDependency) {
      return {
        harmonyImport: true,
        request: dep.request,
      };
    }
    if (dep instanceof HarmonyExportImportedSpecifierDependency) {
      return {
        harmonyRequest: dep.importDependency.request,
        harmonyExportImportedSpecifier: true,
        harmonyId: dep.id,
        harmonyName: dep.name,
      };
    }
    if (dep instanceof HarmonyImportSpecifierDependency) {
      return {
        harmonyRequest: dep.importDependency.request,
        harmonyImportSpecifier: true,
        harmonyId: dep.id,
        harmonyName: dep.name,
        loc: dep.loc,
      };
    }
    if (dep.originModule) {
      return {
        harmonyExport: true,
        harmonyId: dep.id,
        harmonyName: dep.describeHarmonyExport().exportedName,
        harmonyPrecedence: dep.describeHarmonyExport().precedence,
      };
    }
    return carry;
  });
}

function HarmonyDependencyThawPlugin() {
}

HarmonyDependencyThawPlugin.prototype.apply = function(hardSource) {
  if (typeof HarmonyImportDependency === 'undefined') {
    return;
  }

  hardSource.plugin('thaw-dependency', function(carry, req, state) {
    if (req.harmonyExport) {
      return new HardHarmonyExportDependency(parent, req.harmonyId, req.harmonyName, req.harmonyPrecedence);
    }
    if (req.harmonyImport) {
      return state.imports[req.request] = new HardHarmonyImportDependency(req.request);
    }
    if (req.harmonyImportSpecifier) {
      var dep = new HardHarmonyImportSpecifierDependency(state.imports[req.harmonyRequest], req.harmonyId, req.harmonyName);
      dep.loc = req.loc;
      return dep;
    }
    if (req.harmonyExportImportedSpecifier) {
      return new HardHarmonyExportImportedSpecifierDependency(parent, state.imports[req.harmonyRequest], req.harmonyId, req.harmonyName);
    }
    return carry;
  });
};

function ModuleSerializePlugin() {
}

ModuleSerializePlugin.prototype.apply = function(hardSource) {
  hardSource.plugin('freeze-module', function(carry, module, compilation) {
    var devtoolOptions = this.devtoolOptions;
    var existingCacheItem = this.getModuleCache()[module.identifier()];

    if (
      module.request &&
      module.cacheable &&
      !(module instanceof HardModule) &&
      (module instanceof NormalModule) &&
      (
        existingCacheItem &&
        module.buildTimestamp > existingCacheItem.buildTimestamp ||
        !existingCacheItem
      )
    ) {
      var source = module.source(
        compilation.dependencyTemplates,
        compilation.moduleTemplate.outputOptions, 
        compilation.moduleTemplate.requestShortener
      );
      return {
        moduleId: module.id,
        context: module.context,
        request: module.request,
        userRequest: module.userRequest,
        rawRequest: module.rawRequest,
        resource: module.resource,
        loaders: module.loaders,
        identifier: module.identifier(),
        // libIdent: module.libIdent &&
        // module.libIdent({context: compiler.options.context}),
        assets: Object.keys(module.assets || {}),
        buildTimestamp: module.buildTimestamp,
        strict: module.strict,
        meta: module.meta,
        used: module.used,
        usedExports: module.usedExports,

        rawSource: module._source ? module._source.source() : null,
        source: source.source(),
        map: devtoolOptions && source.map(devtoolOptions),
        // Some plugins (e.g. UglifyJs) set useSourceMap on a module. If that
        // option is set we should always store some source map info and
        // separating it from the normal devtool options may be necessary.
        baseMap: module.useSourceMap && source.map(),
        hashContent: serializeHashContent(module),

        dependencies: serializeDependencies.call(this, module.dependencies),
        variables: serializeVariables.call(this, module.variables),
        blocks: serializeBlocks.call(this, module.blocks),

        fileDependencies: module.fileDependencies,
        contextDependencies: module.contextDependencies,
      };
    }
    return carry;
  });

  hardSource.plugin('freeze-asset', function(carry, asset, module) {
    return asset.source();
  });
};

function FileTimestampPlugin() {}

FileTimestampPlugin.getStamps = function(hardSource) {
  return hardSource.__fileTimestampPlugin.fileTimestamps;
};

FileTimestampPlugin.prototype.apply = function(hardSource) {
  if (hardSource.__fileTimestampPlugin) {return;}

  var _this = hardSource.__fileTimestampPlugin = this;

  hardSource.plugin('reset', function() {
    _this.fileDependencies = {};
  });

  hardSource.plugin('compiler', function(compiler) {
    compiler.plugin('compilation', function(compilation) {
      compilation.fileTimestamps = _this.fileTimestamps;
    });
  });

  hardSource.plugin('before-dependency-bust', function(cb) {
    var dataCache = this.getDataCache();
    // if(!this.cache.data.fileDependencies) return cb();
    // var fs = compiler.inputFileSystem;
    var fileTs = this.compiler.fileTimestamps = _this.fileTimestamps = {};

    return Promise.all((dataCache.fileDependencies || []).map(function(file) {
      return fsStat(file)
      .then(function(stat) {
        fileTs[file] = stat.mtime || Infinity;
      }, function(err) {
        fileTs[file] = 0;

        if (err.code === "ENOENT") {return;}
        throw err;
      });
    }))
    .then(function() {cb();}, cb);
  });

  hardSource.plugin('freeze-compilation-data', function(out, compilation) {
    var dataCache = this.getDataCache();

    var fileDependenciesDiff = lodash.difference(
      compilation.fileDependencies,
      dataCache.fileDependencies || []
    );
    if (fileDependenciesDiff.length) {
      dataCache.fileDependencies = (dataCache.fileDependencies || [])
      .concat(fileDependenciesDiff);

      out.fileDependencies = dataCache.fileDependencies;
    }
  });
};

function ResolveCachePlugin() {}

ResolveCachePlugin.prototype.apply = function(hardSource) {
  new FileTimestampPlugin().apply(hardSource);

  var resolveCache = {};

  hardSource.plugin('reset', function() {
    resolveCache = {};
  });

  hardSource.plugin('thaw-compilation-data', function(dataCache) {
    resolveCache = dataCache.resolve;
  });

  hardSource.plugin('freeze-compilation-data', function(dataOut) {
    dataOut.resolve = resolveCache;
  });

  hardSource.plugin('compiler', function(compiler) {
    compiler.plugin('compilation', function(compilation, params) {
      var fileTimestamps = FileTimestampPlugin.getStamps(hardSource);

      params.normalModuleFactory.plugin('resolver', function(fn) {
        return function(request, cb) {
          var cacheId = JSON.stringify([request.context, request.request]);

          var next = function() {
            var originalRequest = request;
            return fn.call(null, request, function(err, request) {
              if (err) {
                return cb(err);
              }
              if (!request.source) {
                resolveCache[cacheId] = Object.assign({}, request, {
                  parser: null,
                  dependencies: null,
                });
              }
              cb.apply(null, arguments);
            });
          };

          var fromCache = function() {
            var result = Object.assign({}, resolveCache[cacheId]);
            result.dependencies = request.dependencies;
            result.parser = compilation.compiler.parser;
            return cb(null, result);
          };

          if (resolveCache[cacheId]) {
            var userRequest = resolveCache[cacheId].userRequest;
            if (fileTimestamps[userRequest]) {
              return fromCache();
            }
            return fs.stat(userRequest, function(err) {
              if (!err) {
                return fromCache();
              }

              next();
            });
          }

          next();
        };
      });
    });
  });
};

function BustModuleByDependencyPlugin() {}

BustModuleByDependencyPlugin.prototype.apply = function(hardSource) {
  new FileTimestampPlugin().apply(hardSource);

  hardSource.plugin('dependency-bust', function() {
    var moduleCache = this.getModuleCache();

    // Invalidate modules that depend on a userRequest that is no longer
    // valid.
    var walkDependencyBlock = function(block, callback) {
      block.dependencies.forEach(callback);
      block.variables.forEach(function(variable) {
        variable.dependencies.forEach(callback);
      });
      block.blocks.forEach(function(block) {
        walkDependencyBlock(block, callback);
      });
    };
    var fileTs = FileTimestampPlugin.getStamps(hardSource);
    // Remove the out of date cache modules.
    Object.keys(moduleCache).forEach(function(key) {
      var cacheItem = moduleCache[key];
      if (!cacheItem) {return;}
      if (typeof cacheItem === 'string') {
        cacheItem = JSON.parse(cacheItem);
        moduleCache[key] = cacheItem;
      }
      var validDepends = true;
      walkDependencyBlock(cacheItem, function(cacheDependency) {
        validDepends = validDepends &&
        hardSource.applyPluginsBailResult1('check-dependency', cacheDependency, cacheItem);
      });
      if (!validDepends) {
        cacheItem.invalid = true;
        moduleCache[key] = null;
      }
    });
  });
}

function CheckDependencyCanResolvePlugin() {
}

CheckDependencyCanResolvePlugin.prototype.apply = function(hardSource) {
  new FileTimestampPlugin().apply(hardSource);

  var fileTs;

  hardSource.plugin('before-dependency-bust', function(cb) {
    fileTs = null;
    cb();
  });

  hardSource.plugin('check-dependency', function(cacheDependency, cacheItem) {
    if (!fileTs) {
      fileTs = FileTimestampPlugin.getStamps(hardSource);
    }

    if (
      cacheDependency.contextDependency ||
      typeof cacheDependency.request === 'undefined'
    ) {
      return;
    }

    var resolveId = JSON.stringify(
      [cacheItem.context, cacheDependency.request]
    );
    var resolveItem = resolveCache[resolveId];
    if (
      !resolveItem ||
      !resolveItem.userRequest ||
      fileTs[resolveItem.userRequest] === 0
    ) {
      return false;
    }
  });
};

function PreemptCompilerPlugin() {}

PreemptCompilerPlugin.getCompilation = function(hardSource) {
  return hardSource.__preemptCompilerPlugin.compilation;
};

PreemptCompilerPlugin.prototype.apply = function(hardSource) {
  if (hardSource.__preemptCompilerPlugin) {return;}

  var _this = hardSource.__preemptCompilerPlugin = this;

  hardSource.plugin('before-module-bust', function(cb) {
    var compiler = this.compiler;

    Promise.resolve()
    .then(function() {
      // Ensure records have been read before we use the sub-compiler to
      // invlidate packages before the normal compiler executes.
      if (Object.keys((compiler.compiler || compiler).records).length === 0) {
        return Promise.promisify(
          (compiler.compiler || compiler).readRecords,
          {context: (compiler.compiler || compiler)}
        )();
      }
    })
    .then(function() {
      var _compiler = compiler.compiler || compiler;
      // Create a childCompiler but set it up and run it like it is the original
      // compiler except that it won't finalize the work ('after-compile' step
      // that renders chunks).
      var childCompiler = _compiler.createChildCompiler();
      // Copy 'this-compilation' and 'make' as well as other plugins.
      for(var name in _compiler._plugins) {
        if(["compile", "emit", "after-emit", "invalid", "done"].indexOf(name) < 0)
          childCompiler._plugins[name] = _compiler._plugins[name].slice();
      }
      // Use the parent's records.
      childCompiler.records = (compiler.compiler || compiler).records;

      var params = childCompiler.newCompilationParams();
      childCompiler.applyPlugins("compile", params);

      var compilation = _this.compilation = childCompiler.newCompilation(params);

      // Run make and seal. This is enough to find out if any module should be
      // invalidated due to some built state.
      return Promise.promisify(childCompiler.applyPluginsParallel, {context: childCompiler})("make", compilation)
      .then(function() {
        return Promise.promisify(compilation.seal, {context: compilation})();
      });
    })
    .then(function() {cb();}, cb);
  });
};

function BustModulePlugin() {}

BustModulePlugin.prototype.apply = function(hardSource) {
  hardSource.plugin('module-bust', function() {
    var moduleCache = hardSource.getModuleCache();

    Object.keys(moduleCache).forEach(function(key) {
      var cacheItem = moduleCache[key];
      if (cacheItem) {
        if (hardSource.applyPluginsBailResult1('check-module', cacheItem) === false) {
          cacheItem.invalid = true;
          moduleCache[module.request] = null;
        }
      }
    });
  });
};

function CheckModuleUsedFlagPlugin() {
}

CheckModuleUsedFlagPlugin.prototype.apply = function(hardSource) {
  if (!NormalModule.prototype.isUsed) {return;}

  new PreemptCompilerPlugin().apply(hardSource);

  var _modules;
  function modules() {
    if (_modules) {return _modules;}

    var compilation = PreemptCompilerPlugin.getCompilation(hardSource);
    _modules = {};
    compilation.modules.forEach(function(module) {
      if (!(module instanceof HardModule)) {
        return;
      }

      _modules[module.identifier()] = module;
    });
    return _modules;
  }

  hardSource.plugin('before-module-bust', function(cb) {
    _modules = {};
    cb();
  });

  hardSource.plugin('check-module', function(cacheItem) {
    var module = modules()[cacheItem.identifier];
    if (!module) {return;}
    // Check with the module in the sub-compiler and invalidate if cached one
    // used and usedExports do not match their new values due to a dependent
    // module changing what it uses.
    if (
      !lodash.isEqual(cacheItem.used, module.used) ||
      !lodash.isEqual(cacheItem.usedExports, module.usedExports)
    ) {
      return false;
    }
  });
};

function HardSourceWebpackPlugin(options) {
  Tapable.call(this);
  this.options = options;

  new DependencySerializePlugin().apply(this);
  new DependencyThawPlugin().apply(this);
  new HarmonyDependencySerializePlugin().apply(this);
  new HarmonyDependencyThawPlugin().apply(this);

  new ResolveCachePlugin().apply(this);
  new BustModuleByDependencyPlugin().apply(this);
  new CheckDependencyCanResolvePlugin().apply(this);
  new BustModulePlugin().apply(this);
  new CheckModuleUsedFlagPlugin().apply(this);

  new ModuleSerializePlugin().apply(this);
}

HardSourceWebpackPlugin.prototype = Object.create(Tapable.prototype);
HardSourceWebpackPlugin.prototype.constructor = HardSourceWebpackPlugin;

HardSourceWebpackPlugin.prototype.getPath = function(dirName, suffix) {
  var confighashIndex = dirName.search(/\[confighash\]/);
  if (confighashIndex !== -1) {
    dirName = dirName.replace(/\[confighash\]/, this.configHash);
  }
  var cachePath = path.resolve(
    process.cwd(), this.compilerOutputOptions.path, dirName
  );
  if (suffix) {
    cachePath = path.join(cachePath, suffix);
  }
  return cachePath;
};

HardSourceWebpackPlugin.prototype.getCachePath = function(suffix) {
  return this.getPath(this.options.cacheDirectory, suffix);
};

HardSourceWebpackPlugin.prototype.applyPluginsPromise = function(name, args) {
  return Promise.promisify(this.applyPluginsAsync).apply(this, arguments);
};

HardSourceWebpackPlugin.prototype.freeze = function(supertype, object) {
  return this.applyPluginsWaterfall('freeze-' + supertype, null, object);
};

HardSourceWebpackPlugin.prototype.thaw = function(supertype, object) {
  return this.applyPluginsWaterfall('thaw-' + supertype, null, object);
};

HardSourceWebpackPlugin.prototype.valid = function(supertype, object) {
  return this.applyPluginsBailResult1('valid-' + supertype, object);
};

HardSourceWebpackPlugin.prototype.getModuleCache = function() {
  return this.moduleCache;
};

HardSourceWebpackPlugin.prototype.getAssetCache = function() {
  return this.assetCache;
};

HardSourceWebpackPlugin.prototype.getDataCache = function() {
  return this.dataCache;
};

module.exports = HardSourceWebpackPlugin;
HardSourceWebpackPlugin.prototype.apply = function(compiler) {
  var _this = this;
  var options = this.options;
  var active = true;
  if (!options.cacheDirectory) {
    console.error('HardSourceWebpackPlugin requires a cacheDirectory setting.');
    active = false;
    return;
  }

  this.compilerOutputOptions = compiler.options.output;
  if (options.configHash) {
    if (typeof options.configHash === 'string') {
      this.configHash = options.configHash;
    }
    else if (typeof options.configHash === 'function') {
      this.configHash = options.configHash(compiler.options);
    }
  }
  var configHashInDirectory =
    options.cacheDirectory.search(/\[confighash\]/) !== -1;
  if (configHashInDirectory && !this.configHash) {
    console.error('HardSourceWebpackPlugin cannot use [confighash] in cacheDirectory without configHash option being set and returning a non-falsy value.');
    active = false;
    return;
  }

  if (options.recordsInputPath || options.recordsPath) {
    if (compiler.options.recordsInputPath || compiler.options.recordsPath) {
      console.error('HardSourceWebpackPlugin will not set recordsInputPath when it is already set. Using current value:', compiler.options.recordsInputPath || compiler.options.recordsPath);
    }
    else {
      compiler.options.recordsInputPath =
        this.getPath(options.recordsInputPath || options.recordsPath);
    }
  }
  if (options.recordsOutputPath || options.recordsPath) {
    if (compiler.options.recordsOutputPath || compiler.options.recordsPath) {
      console.error('HardSourceWebpackPlugin will not set recordsOutputPath when it is already set. Using current value:', compiler.options.recordsOutputPath || compiler.options.recordsPath);
    }
    else {
      compiler.options.recordsOutputPath =
        this.getPath(options.recordsOutputPath || options.recordsPath);
    }
  }

  var cacheDirPath = this.getCachePath();
  var cacheAssetDirPath = path.join(cacheDirPath, 'assets');
  var resolveCachePath = path.join(cacheDirPath, 'resolve.json');

  var moduleCache = this.moduleCache = {};
  var assetCache = this.assetCache = {};
  var dataCache = this.dataCache = {};
  var currentStamp = '';

  var fileTimestamps = {};

  var assetCacheSerializer = this.assetCacheSerializer =
    new FileSerializer({cacheDirPath: path.join(cacheDirPath, 'assets')});
  var moduleCacheSerializer = this.moduleCacheSerializer =
    new LevelDbSerializer({cacheDirPath: path.join(cacheDirPath, 'modules')});
  var dataCacheSerializer = this.dataCacheSerializer =
    new LevelDbSerializer({cacheDirPath: path.join(cacheDirPath, 'data')});

  _this.compiler = compiler;

  _this.applyPlugins('compiler', compiler);

  compiler.plugin('after-plugins', function() {
    if (
      !compiler.recordsInputPath || !compiler.recordsOutputPath
    ) {
      console.error('HardSourceWebpackPlugin requires recordsPath to be set.');
      active = false;
    }
  });

  compiler.plugin(['watch-run', 'run'], function(compiler, cb) {
    if (!active) {return cb();}

    try {
      fs.statSync(cacheAssetDirPath);
    }
    catch (_) {
      mkdirp.sync(cacheAssetDirPath);
      if (configHashInDirectory) {
        console.log('HardSourceWebpackPlugin is writing to a new confighash path for the first time:', cacheDirPath);
      }
    }
    var start = Date.now();

    Promise.all([
      fsReadFile(path.join(cacheDirPath, 'stamp'), 'utf8')
      .catch(function() {return '';}),

      (function() {
        if (options.environmentPaths === false) {
          return Promise.resolve('');
        }
        return envHash(options.environmentPaths);
      })(),
    ])
    .then(function(stamps) {
      var stamp = stamps[0];
      var hash = stamps[1];

      if (!configHashInDirectory && options.configHash) {
        hash += '_' + _this.configHash;
      }

      currentStamp = hash;
      if (!hash || hash !== stamp) {
        if (hash && stamp) {
          console.error('Environment has changed (node_modules or configuration was updated).\nHardSourceWebpackPlugin will reset the cache and store a fresh one.');
        }

        // Reset the cache, we can't use it do to an environment change.
        _this.applyPlugins('reset');
        moduleCache = this.moduleCache = {};
        assetCache = this.assetCache = {};
        dataCache = this.dataCache = {};
        return;
      }

      if (Object.keys(moduleCache).length) {return Promise.resolve();}

      return Promise.all([
        assetCacheSerializer.read()
        .then(function(_assetCache) {assetCache = _assetCache;}),

        moduleCacheSerializer.read()
        .then(function(_moduleCache) {moduleCache = _moduleCache;}),

        dataCacheSerializer.read()
        .then(function(_dataCache) {dataCache = _dataCache;})
        .then(function() {
          Object.keys(dataCache).forEach(function(key) {
            if (typeof dataCache[key] === 'string') {
              dataCache[key] = JSON.parse(dataCache[key]);
            }
          });

          _this.applyPlugins('thaw-compilation-data', dataCache);
        }),
      ])
      .then(function() {
        // console.log('cache in', Date.now() - start);
      });
    })
    .then(cb, cb);
  });

  compiler.plugin(['watch-run', 'run'], function(compiler, cb) {
    if (!active) {return cb();}

    return Promise.resolve()
    .then(function() {return _this.applyPluginsPromise('before-dependency-bust');})
    .then(function() {return _this.applyPlugins('dependency-bust');})
    .then(function() {return _this.applyPluginsPromise('after-dependency-bust');})
    .then(function() {return _this.applyPluginsPromise('before-module-bust');})
    .then(function() {return _this.applyPlugins('module-bust');})
    .then(function() {return _this.applyPluginsPromise('after-module-bust');})
    .then(function() {cb();}, cb);
  });

  compiler.plugin('compilation', function(compilation, params) {
    if (!active) {return;}

    compilation.__hardSource = _this;

    compilation.dependencyFactories.set(HardModuleDependency, params.normalModuleFactory);
    compilation.dependencyTemplates.set(HardModuleDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardContextDependency, params.contextModuleFactory);
    compilation.dependencyTemplates.set(HardContextDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardNullDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardNullDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyExportDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyExportDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyImportDependency, params.normalModuleFactory);
    compilation.dependencyTemplates.set(HardHarmonyImportDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyImportSpecifierDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyImportSpecifierDependency, new NullDependencyTemplate);

    compilation.dependencyFactories.set(HardHarmonyExportImportedSpecifierDependency, new NullFactory());
    compilation.dependencyTemplates.set(HardHarmonyExportImportedSpecifierDependency, new NullDependencyTemplate);

    var needAdditionalPass;

    compilation.plugin('after-seal', function(cb) {
      needAdditionalPass = compilation.modules.reduce(function(carry, module) {
        var cacheItem = moduleCache[module.identifier()];
        if (cacheItem && (
          !lodash.isEqual(cacheItem.used, module.used) ||
          !lodash.isEqual(cacheItem.usedExports, module.usedExports)
        )) {
          cacheItem.invalid = true;
          moduleCache[module.request] = null;
          return true;
        }
        return carry;
      }, false);
      cb();
    });

    compilation.plugin('need-additional-pass', function() {
      if (needAdditionalPass) {
        needAdditionalPass = false;
        return true;
      }
    });

    params.normalModuleFactory.plugin('resolver', function(fn) {
      return function(request, cb) {
        fn.call(null, request, function(err, result) {
          if (err) {return cb(err);}
          else if (moduleCache[result.request]) {
            var cacheItem = moduleCache[result.request];
            if (typeof cacheItem === 'string') {
              cacheItem = JSON.parse(cacheItem);
              moduleCache[result.request] = cacheItem;
            }
            if (Array.isArray(cacheItem.assets)) {
              cacheItem.assets = (cacheItem.assets || [])
              .reduce(function(carry, key) {
                carry[key] = assetCache[requestHash(key)];
                return carry;
              }, {});
            }
            if (!HardModule.needRebuild(
              cacheItem.buildTimestamp,
              cacheItem.fileDependencies,
              cacheItem.contextDependencies,
              // [],
              fileTimestamps,
              compiler.contextTimestamps
            )) {
              var module = new HardModule(cacheItem);
              return cb(null, module);
            }
          }
          return cb(null, result);
        });
      };
    });

    params.normalModuleFactory.plugin('module', function(module) {
      // module.isUsed = function(exportName) {
      //   return exportName ? exportName : false;
      // };
      return module;
    });
  });

  compiler.plugin('after-compile', function(compilation, cb) {
    if (!active) {return cb();}

    var startCacheTime = Date.now();

    var devtoolOptions = _this.devtoolOptions = makeDevtoolOptions(compiler.options);

    // fs.writeFileSync(
    //   path.join(cacheDirPath, 'file-dependencies.json'),
    //   JSON.stringify({fileDependencies: compilation.fileDependencies}),
    //   'utf8'
    // );

    var moduleOps = [];
    var dataOps = [];
    var assetOps = [];

    var dataOut = {};
    _this.applyPlugins('freeze-compilation-data', dataOut, compilation);

    Object.keys(dataOut).forEach(function(key) {
      var data = dataOut[key];
      dataCache[key] = data;
      dataOps.push({
        key: key,
        value: JSON.stringify(data),
      });
    });

    compilation.modules.forEach(function(module, cb) {
      var frozenModule = this.applyPluginsWaterfall('freeze-module', null, module, compilation);
      if (frozenModule) {
        moduleCache[module.identifier()] = frozenModule;

        moduleOps.push({
          key: module.identifier(),
          value: JSON.stringify(frozenModule),
        });

        if (module.assets) {
          Object.keys(module.assets).forEach(function(key) {
            var asset = module.assets[key];
            var frozen = this.applyPluginsWaterfall('freeze-asset', null, asset, module);
            if (frozen) {
              var frozenKey = requestHash(key);

              assetCache[frozenKey] = frozen;

              assetOps.push({
                key: frozenKey,
                value: frozen,
              });
            }
          }, this);
        }
      }
    }, _this);

    Promise.all([
      fsWriteFile(path.join(cacheDirPath, 'stamp'), currentStamp, 'utf8'),
      assetCacheSerializer.write(assetOps),
      moduleCacheSerializer.write(moduleOps),
      dataCacheSerializer.write(dataOps),
    ])
    .then(function() {
      // console.log('cache out', Date.now() - startCacheTime);
      cb();
    }, cb);
  });

  // Ensure records are stored inbetween runs of memory-fs using
  // webpack-dev-middleware.
  compiler.plugin('done', function() {
    if (!active) {return;}

    fs.writeFileSync(
      path.resolve(compiler.options.context, compiler.recordsOutputPath),
      JSON.stringify(compiler.records, null, 2),
      'utf8'
    );
  });
};
