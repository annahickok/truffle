const OS = require("os");
const semver = require("semver");

const CompileError = require("./compileerror");
const CompilerSupplier = require("./compilerSupplier");

async function run(rawSources, options) {
  if (Object.keys(rawSources).length === 0) {
    return {
      contracts: [],
      sourceIndexes: [],
      compilerInfo: undefined
    };
  }

  // Ensure sources have operating system independent paths
  // i.e., convert backslashes to forward slashes; things like C: are left intact.
  const { sources, targets, originalSourcePaths } = collectSources(
    rawSources,
    options.compilationTargets
  );

  // construct solc compiler input
  const compilerInput = prepareCompilerInput({
    sources,
    targets,
    settings: options.compilers.solc.settings
  });

  // perform compilation
  const { compilerOutput, solcVersion } = await invokeCompiler({
    compilerInput,
    options
  });

  // handle warnings as errors if options.strict
  // log if not options.quiet
  const { warnings, errors } = detectErrors({ compilerOutput, options });
  if (warnings.length > 0 && !options.quiet) {
    options.logger.log(
      OS.EOL + "    > compilation warnings encountered:" + OS.EOL
    );
    options.logger.log(warnings);
  }

  if (errors.length > 0) {
    if (!options.quiet) {
      options.logger.log("");
    }

    throw new CompileError(errors);
  }

  // success case
  return {
    sourceIndexes: processSources({
      compilerOutput,
      originalSourcePaths
    }),
    contracts: processContracts({
      sources,
      compilerOutput,
      solcVersion,
      originalSourcePaths
    }),
    compilerInfo: {
      name: "solc",
      version: solcVersion
    }
  };
}

/**
 * Collects sources, targets into collections with OS-independent paths,
 * along with a reverse mapping to the original path (for post-processing)
 *
 * @param originalSources - { [originalSourcePath]: contents }
 * @param originalTargets - originalSourcePath[]
 * @return { sources, targets, originalSourcePaths }
 */
function collectSources(originalSources, originalTargets = []) {
  const mappedResults = Object.entries(originalSources)
    .map(([originalSourcePath, contents]) => ({
      originalSourcePath,
      contents,
      sourcePath: getPortableSourcePath(originalSourcePath)
    }))
    .map(({ originalSourcePath, sourcePath, contents }) => ({
      sources: {
        [sourcePath]: contents
      },

      // include transformed form as target if original is a target
      targets: originalTargets.includes(originalSourcePath) ? [sourcePath] : [],

      originalSourcePaths: {
        [sourcePath]: originalSourcePath
      }
    }));

  const defaultAccumulator = {
    sources: {},
    targets: [],
    originalSourcePaths: {}
  };

  return mappedResults.reduce(
    (accumulator, result) => ({
      sources: Object.assign({}, accumulator.sources, result.sources),
      targets: [...accumulator.targets, ...result.targets],
      originalSourcePaths: Object.assign(
        {},
        accumulator.originalSourcePaths,
        result.originalSourcePaths
      )
    }),
    defaultAccumulator
  );
}

/**
 * @param sourcePath - string
 * @return string - operating system independent path
 * @private
 */
function getPortableSourcePath(sourcePath) {
  // Turn all backslashes into forward slashes
  var replacement = sourcePath.replace(/\\/g, "/");

  // Turn G:/.../ into /G/.../ for Windows
  if (replacement.length >= 2 && replacement[1] === ":") {
    replacement = "/" + replacement;
    replacement = replacement.replace(":", "");
  }

  return replacement;
}

/**
 *
 */
function prepareCompilerInput({ sources, targets, settings }) {
  return {
    language: "Solidity",
    sources: prepareSources({ sources }),
    settings: {
      evmVersion: settings.evmVersion,
      optimizer: settings.optimizer,
      outputSelection: prepareOutputSelection({ targets })
    }
  };
}

function prepareSources({ sources }) {
  return Object.entries(sources)
    .map(([sourcePath, content]) => ({ [sourcePath]: { content } }))
    .reduce((a, b) => Object.assign({}, a, b), {});
}

const defaultSelectors = {
  "": ["legacyAST", "ast"],
  "*": [
    "abi",
    "metadata",
    "evm.bytecode.object",
    "evm.bytecode.sourceMap",
    "evm.deployedBytecode.object",
    "evm.deployedBytecode.sourceMap",
    "userdoc",
    "devdoc"
  ]
};

/**
 * If targets are specified, specify output selectors fo each individually.
 * Otherwise, just use "*" selector
 */
function prepareOutputSelection({ targets = [] }) {
  if (!targets.length) {
    return {
      "*": defaultSelectors
    };
  }

  return targets
    .map(target => ({ [target]: defaultSelectors }))
    .reduce((a, b) => Object.assign({}, a, b), {});
}

/**
 * Load solc and perform compilation
 */
async function invokeCompiler({ compilerInput, options }) {
  // load solc
  const supplier = new CompilerSupplier(options.compilers.solc);
  const [solc] = await supplier.load();
  const solcVersion = solc.version();

  // perform compilation
  const inputString = JSON.stringify(compilerInput);
  const outputString = solc.compile(inputString);
  const compilerOutput = JSON.parse(outputString);

  return {
    compilerOutput,
    solcVersion
  };
}

/**
 * Extract errors/warnings from compiler output based on strict mode setting
 * @return { errors: string, warnings: string }
 */
function detectErrors({ compilerOutput: { errors: outputErrors }, options }) {
  outputErrors = outputErrors || [];
  const rawErrors = options.strict
    ? outputErrors
    : outputErrors.filter(({ severity }) => severity !== "warning");

  const rawWarnings = options.strict
    ? [] // none of those in strict mode
    : outputErrors.filter(({ severity }) => severity === "warning");

  // extract messages
  let errors = rawErrors.map(({ formattedMessage }) => formattedMessage).join();
  const warnings = rawWarnings
    .map(({ formattedMessage }) => formattedMessage)
    .join();

  if (errors.includes("requires different compiler version")) {
    const contractSolcVer = errors.match(/pragma solidity[^;]*/gm)[0];
    const configSolcVer =
      options.compilers.solc.version || semver.valid(solc.version());

    errors = errors.concat(
      [
        OS.EOL,
        `Error: Truffle is currently using solc ${configSolcVer}, `,
        `but one or more of your contracts specify "${contractSolcVer}".`,
        OS.EOL,
        `Please update your truffle config or pragma statement(s).`,
        OS.EOL,
        `(See https://truffleframework.com/docs/truffle/reference/configuration#compiler-configuration `,
        `for information on`,
        OS.EOL,
        `configuring Truffle to use a specific solc compiler version.)`
      ].join("")
    );
  }

  return { warnings, errors };
}

/**
 * Aggregate list of sources based on reported source index
 * Returns list transformed to use original source paths
 */
function processSources({ compilerOutput, originalSourcePaths }) {
  let files = [];

  for (let [sourcePath, { id }] of Object.entries(compilerOutput.sources)) {
    files[id] = originalSourcePaths[sourcePath];
  }

  return files;
}

/**
 * Converts compiler-output contracts into truffle-compile's return format
 * Uses compiler contrarct output plus other information.
 */
function processContracts({
  compilerOutput,
  sources,
  originalSourcePaths,
  solcVersion
}) {
  return (
    Object.entries(compilerOutput.contracts)
      // map to [[{ source, contractName, contract }]]
      .map(([sourcePath, sourceContracts]) =>
        Object.entries(sourceContracts).map(([contractName, contract]) => ({
          contractName,
          contract,
          source: {
            ast: compilerOutput.sources[sourcePath].ast,
            legacyAST: compilerOutput.sources[sourcePath].legacyAST,
            contents: sources[sourcePath],
            sourcePath
          }
        }))
      )
      // and flatten
      .reduce((a, b) => [...a, ...b], [])

      // All source will have a key, but only the compiled source will have
      // the evm output.
      .filter(({ contract: { evm } }) => Object.keys(evm).length > 0)

      // convert to output format
      .map(
        ({
          contractName,
          contract: {
            evm: {
              bytecode: { sourceMap, linkReferences, object: bytecode },
              deployedBytecode: {
                sourceMap: deployedSourceMap,
                linkReferences: deployedLinkReferences,
                object: deployedBytecode
              }
            },
            abi,
            metadata,
            devdoc,
            userdoc
          },
          source: {
            ast,
            legacyAST,
            sourcePath: transformedSourcePath,
            contents: source
          }
        }) => ({
          contractName,
          abi: orderABI({ abi, contractName, ast }),
          metadata,
          devdoc,
          userdoc,
          sourcePath: originalSourcePaths[transformedSourcePath],
          source,
          sourceMap,
          deployedSourceMap,
          ast,
          legacyAST,
          bytecode: replaceAllLinkReferences({
            bytecode,
            linkReferences
          }),
          deployedBytecode: replaceAllLinkReferences({
            bytecode: deployedBytecode,
            linkReferences: deployedLinkReferences
          }),
          compiler: {
            name: "solc",
            version: solcVersion
          }
        })
      )
  );
}

function orderABI({ abi, contractName, ast }) {
  // AST can have multiple contract definitions, make sure we have the
  // one that matches our contract
  const contractDefinition = ast.nodes.filter(
    ({ nodeType, name }) =>
      nodeType === "ContractDefinition" && name === contractName
  )[0];

  if (!contractDefinition || !contractDefinition.nodes) {
    return abi;
  }

  // Find all function definitions
  const orderedFunctionNames = contractDefinition.nodes
    .filter(({ nodeType }) => nodeType === "FunctionDefinition")
    .map(({ name: functionName }) => functionName);

  // Put function names in a hash with their order, lowest first, for speed.
  const functionIndexes = orderedFunctionNames
    .map((functionName, index) => ({ [functionName]: index }))
    .reduce((a, b) => Object.assign({}, a, b), {});

  // Construct new ABI with functions at the end in source order
  return [
    ...abi.filter(({ name }) => functionIndexes[name] === undefined),

    // followed by the functions in the source order
    ...abi
      .filter(({ name }) => functionIndexes[name] !== undefined)
      .sort(
        ({ name: a }, { name: b }) => functionIndexes[a] - functionIndexes[b]
      )
  ];
}

function replaceAllLinkReferences({ bytecode, linkReferences }) {
  // convert to flat list
  const libraryLinkReferences = Object.values(linkReferences)
    .map(fileLinks =>
      Object.entries(fileLinks).map(([libraryName, links]) => ({
        libraryName,
        links
      }))
    )
    .reduce((a, b) => [...a, ...b], []);

  const unprefixed = libraryLinkReferences.reduce(
    (bytecode, { libraryName, links }) =>
      replaceLinkReferences(bytecode, links, libraryName),
    bytecode
  );

  return `0x${unprefixed}`;
}

function replaceLinkReferences(bytecode, linkReferences, libraryName) {
  var linkId = "__" + libraryName;

  while (linkId.length < 40) {
    linkId += "_";
  }

  linkReferences.forEach(function(ref) {
    // ref.start is a byte offset. Convert it to character offset.
    var start = ref.start * 2;

    bytecode =
      bytecode.substring(0, start) + linkId + bytecode.substring(start + 40);
  });

  return bytecode;
}

module.exports = { run };