module.exports = {
  shimOutput({ contracts: list, sourceIndexes, compilerInfo }) {
    const contracts = list
      // get old format
      .map(this.shimContract)
      // get pair
      .map(contract => ({ [contract.contract_name]: contract }))
      // merge pairs
      .reduce((a, b) => Object.assign({}, a, b), {});

    return [contracts, sourceIndexes, compilerInfo];
  },

  shimContract(contract) {
    const {
      contractName,
      sourcePath,
      source,
      sourceMap,
      deployedSourceMap,
      legacyAST,
      ast,
      abi,
      metadata,
      bytecode,
      deployedBytecode,
      compiler,
      devdoc,
      userdoc
    } = contract;

    return {
      contract_name: contractName,
      sourcePath,
      source,
      sourceMap,
      deployedSourceMap,
      legacyAST,
      ast,
      abi,
      metadata,
      bytecode: this.shimBytecode(bytecode),
      deployedBytecode: this.shimBytecode(deployedBytecode),
      unlinked_binary: this.shimBytecode(bytecode),
      compiler,
      devdoc,
      userdoc
    };
  },

  shimBytecode(bytecode) {
    return bytecode;
  }
};
