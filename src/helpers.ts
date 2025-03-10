/* eslint-disable @typescript-eslint/no-explicit-any */
import {Signer} from '@ethersproject/abstract-signer';
import {
  Web3Provider,
  TransactionResponse,
  TransactionRequest,
} from '@ethersproject/providers';
import {getAddress} from '@ethersproject/address';
import {
  Contract,
  ContractFactory,
  PayableOverrides,
} from '@ethersproject/contracts';
import {AddressZero} from '@ethersproject/constants';
import {BigNumber} from '@ethersproject/bignumber';
import {Wallet} from '@ethersproject/wallet';
import {keccak256 as solidityKeccak256} from '@ethersproject/solidity';
import {zeroPad, hexlify} from '@ethersproject/bytes';
import {Interface, FunctionFragment} from '@ethersproject/abi';
import {
  Deployment,
  DeployResult,
  DeploymentsExtension,
  DeployOptions,
  TxOptions,
  CallOptions,
  SimpleTx,
  Receipt,
  Address,
  DiamondOptions,
  Create2DeployOptions,
  FacetCut,
  DeploymentSubmission,
  ExtendedArtifact,
  FacetCutAction,
  Facet,
  ArtifactData,
  ABI,
} from '../types';
import {PartialExtension} from './internal/types';
import {UnknownSignerError} from './errors';
import {mergeABIs, recode} from './utils';
import fs from 'fs-extra';

import OpenZeppelinTransparentProxy from '../extendedArtifacts/TransparentUpgradeableProxy.json';
import OptimizedTransparentUpgradeableProxy from '../extendedArtifacts/OptimizedTransparentUpgradeableProxy.json';
import DefaultProxyAdmin from '../extendedArtifacts/ProxyAdmin.json';
import eip173Proxy from '../extendedArtifacts/EIP173Proxy.json';
import eip173ProxyWithReceive from '../extendedArtifacts/EIP173ProxyWithReceive.json';
import diamondBase from '../extendedArtifacts/Diamond.json';
import diamondCutFacet from '../extendedArtifacts/DiamondCutFacet.json';
import diamondLoupeFacet from '../extendedArtifacts/DiamondLoupeFacet.json';
import ownershipFacet from '../extendedArtifacts/OwnershipFacet.json';
import diamantaire from '../extendedArtifacts/Diamantaire.json';
import {Artifact, EthereumProvider, Network} from 'hardhat/types';
import {DeploymentsManager} from './DeploymentsManager';
import enquirer from 'enquirer';
import {
  parse as parseTransaction,
  Transaction,
} from '@ethersproject/transactions';

let LedgerSigner: any; // TODO type

diamondBase.abi = mergeABIs(
  [
    diamondBase.abi,
    diamondCutFacet.abi,
    diamondLoupeFacet.abi,
    ownershipFacet.abi,
  ],
  {check: false, skipSupportsInterface: false}
);

async function handleSpecificErrors<T>(p: Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await p;
  } catch (e) {
    if (
      typeof (e as any).message === 'string' &&
      (e as any).message.indexOf('already known') !== -1
    ) {
      console.log(
        `
Exact same transaction already in the pool, node reject duplicates.
You'll need to wait the tx resolve, or increase the gas price via --gasprice (this will use old tx type)
        `
      );
      throw new Error(
        'Exact same transaction already in the pool, node reject duplicates'
      );
      // console.log(
      //   `\nExact same transaction already in the pool, node reject duplicates, waiting for it instead...\n`
      // );
      // const signedTx = await ethersSigner.signTransaction(unsignedTx);
      // const decoded = parseTransaction(signedTx);
      // if (!decoded.hash) {
      //   throw new Error(
      //     'tx with same hash already in the pool, failed to decode to get the hash'
      //   );
      // }
      // const txHash = decoded.hash;
      // tx = Object.assign(decoded as TransactionResponse, {
      //   wait: (confirmations: number) =>
      //     provider.waitForTransaction(txHash, confirmations),
      //   confirmations: 0,
      // });
    } else {
      console.error((e as any).message, JSON.stringify(e), e);
      throw e;
    }
  }
  return result;
}

function fixProvider(providerGiven: any): any {
  // alow it to be used by ethers without any change
  if (providerGiven.sendAsync === undefined) {
    providerGiven.sendAsync = (
      req: {
        id: number;
        jsonrpc: string;
        method: string;
        params: any[];
      },
      callback: (error: any, result: any) => void
    ) => {
      providerGiven
        .send(req.method, req.params)
        .then((result: any) =>
          callback(null, {result, id: req.id, jsonrpc: req.jsonrpc})
        )
        .catch((error: any) => callback(error, null));
    };
  }
  return providerGiven;
}

function findAll(toFind: string[], array: string[]): boolean {
  for (const f of toFind) {
    if (array.indexOf(f) === -1) {
      return false;
    }
  }
  return true;
}

function linkRawLibrary(
  bytecode: string,
  libraryName: string,
  libraryAddress: string
): string {
  const address = libraryAddress.replace('0x', '');
  let encodedLibraryName;
  if (libraryName.startsWith('$') && libraryName.endsWith('$')) {
    encodedLibraryName = libraryName.slice(1, libraryName.length - 1);
  } else {
    encodedLibraryName = solidityKeccak256(['string'], [libraryName]).slice(
      2,
      36
    );
  }
  const pattern = new RegExp(`_+\\$${encodedLibraryName}\\$_+`, 'g');
  if (!pattern.exec(bytecode)) {
    throw new Error(
      `Can't link '${libraryName}' (${encodedLibraryName}) in \n----\n ${bytecode}\n----\n`
    );
  }
  return bytecode.replace(pattern, address);
}

function linkRawLibraries(
  bytecode: string,
  libraries: {[libraryName: string]: Address}
): string {
  for (const libName of Object.keys(libraries)) {
    const libAddress = libraries[libName];
    bytecode = linkRawLibrary(bytecode, libName, libAddress);
  }
  return bytecode;
}

function linkLibraries(
  artifact: {
    bytecode: string;
    linkReferences?: {
      [libraryFileName: string]: {
        [libraryName: string]: Array<{length: number; start: number}>;
      };
    };
  },
  libraries?: {[libraryName: string]: Address}
) {
  let bytecode = artifact.bytecode;

  if (libraries) {
    if (artifact.linkReferences) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const [fileName, fileReferences] of Object.entries(
        artifact.linkReferences
      )) {
        for (const [libName, fixups] of Object.entries(fileReferences)) {
          const addr = libraries[libName];
          if (addr === undefined) {
            continue;
          }

          for (const fixup of fixups) {
            bytecode =
              bytecode.substr(0, 2 + fixup.start * 2) +
              addr.substr(2) +
              bytecode.substr(2 + (fixup.start + fixup.length) * 2);
          }
        }
      }
    } else {
      bytecode = linkRawLibraries(bytecode, libraries);
    }
  }

  // TODO return libraries object with path name <filepath.sol>:<name> for names

  return bytecode;
}

export function addHelpers(
  deploymentManager: DeploymentsManager,
  partialExtension: PartialExtension,
  network: Network,
  getArtifact: (name: string) => Promise<Artifact>,
  saveDeployment: (
    name: string,
    deployment: DeploymentSubmission,
    artifactName?: string
  ) => Promise<void>,
  willSaveToDisk: () => boolean,
  onPendingTx: (
    txResponse: TransactionResponse,
    name?: string,
    data?: any
  ) => Promise<TransactionResponse>,
  getGasPrice: () => Promise<{
    gasPrice: BigNumber | undefined;
    maxFeePerGas: BigNumber | undefined;
    maxPriorityFeePerGas: BigNumber | undefined;
  }>,
  log: (...args: any[]) => void,
  print: (msg: string) => void
): {
  extension: DeploymentsExtension;
  utils: {
    dealWithPendingTransactions: (
      pendingTxs: {
        [txHash: string]: {
          name: string;
          deployment?: any;
          rawTx: string;
          decoded: {
            from: string;
            gasPrice?: string;
            maxFeePerGas?: string;
            maxPriorityFeePerGas?: string;
            gasLimit: string;
            to: string;
            value: string;
            nonce: number;
            data: string;
            r: string;
            s: string;
            v: number;
            // creates: tx.creates, // TODO test
            chainId: number;
          };
        };
      },
      pendingTxPath: string,
      globalGasPrice: string | undefined
    ) => Promise<void>;
  };
} {
  let provider: Web3Provider;
  const availableAccounts: {[name: string]: boolean} = {};

  async function init(): Promise<Web3Provider> {
    if (!provider) {
      await deploymentManager.setupAccounts();
      provider = new Web3Provider(fixProvider(network.provider));
      try {
        const accounts = await provider.send('eth_accounts', []);
        for (const account of accounts) {
          availableAccounts[account.toLowerCase()] = true;
        }

        for (const address of deploymentManager.impersonatedAccounts) {
          availableAccounts[address.toLowerCase()] = true;
        }
      } catch (e) {}
    }
    return provider;
  }

  async function setupGasPrice(
    txRequestOrOverrides: TransactionRequest | PayableOverrides
  ) {
    const gasPriceSetup = await getGasPrice();
    if (!txRequestOrOverrides.gasPrice) {
      txRequestOrOverrides.gasPrice = gasPriceSetup.gasPrice;
    }
    if (!txRequestOrOverrides.maxFeePerGas) {
      txRequestOrOverrides.maxFeePerGas = gasPriceSetup.maxFeePerGas;
    }
    if (!txRequestOrOverrides.maxPriorityFeePerGas) {
      txRequestOrOverrides.maxPriorityFeePerGas =
        gasPriceSetup.maxPriorityFeePerGas;
    }
  }

  async function setupNonce(
    from: string,
    txRequestOrOverrides: TransactionRequest | PayableOverrides
  ) {
    if (
      txRequestOrOverrides.nonce === 'pending' ||
      txRequestOrOverrides.nonce === 'latest'
    ) {
      txRequestOrOverrides.nonce = await provider.getTransactionCount(
        from,
        txRequestOrOverrides.nonce
      );
    } else if (!txRequestOrOverrides.nonce) {
      txRequestOrOverrides.nonce = await provider.getTransactionCount(
        from,
        'latest'
      );
    }
  }

  async function overrideGasLimit(
    txRequestOrOverrides: TransactionRequest | PayableOverrides,
    options: {
      estimatedGasLimit?: number | BigNumber | string;
      estimateGasExtra?: number | BigNumber | string;
    },
    estimate: (
      txRequestOrOverrides: TransactionRequest | PayableOverrides
    ) => Promise<BigNumber>
  ) {
    const estimatedGasLimit = options.estimatedGasLimit
      ? BigNumber.from(options.estimatedGasLimit).toNumber()
      : undefined;
    const estimateGasExtra = options.estimateGasExtra
      ? BigNumber.from(options.estimateGasExtra).toNumber()
      : undefined;
    if (!txRequestOrOverrides.gasLimit) {
      txRequestOrOverrides.gasLimit = estimatedGasLimit;
      txRequestOrOverrides.gasLimit = (
        await estimate(txRequestOrOverrides)
      ).toNumber();
      if (estimateGasExtra) {
        txRequestOrOverrides.gasLimit =
          txRequestOrOverrides.gasLimit + estimateGasExtra;
        if (estimatedGasLimit) {
          txRequestOrOverrides.gasLimit = Math.min(
            txRequestOrOverrides.gasLimit,
            estimatedGasLimit
          );
        }
      }
    }
  }

  function getCreate2Address(
    create2DeployerAddress: Address,
    salt: string,
    bytecode: string
  ): Address {
    return getAddress(
      '0x' +
        solidityKeccak256(
          ['bytes'],
          [
            `0xff${create2DeployerAddress.slice(2)}${salt.slice(
              2
            )}${solidityKeccak256(['bytes'], [bytecode]).slice(2)}`,
          ]
        ).slice(-40)
    );
  }

  async function ensureCreate2DeployerReady(options: {
    from: string;
    log?: boolean;
    gasPrice?: string | BigNumber;
    maxFeePerGas?: string | BigNumber;
    maxPriorityFeePerGas?: string | BigNumber;
  }): Promise<string> {
    const {
      address: from,
      ethersSigner,
      hardwareWallet,
      unknown,
    } = getFrom(options.from);
    const create2DeployerAddress =
      await deploymentManager.getDeterministicDeploymentFactoryAddress();
    const code = await provider.getCode(create2DeployerAddress);
    if (code === '0x') {
      const senderAddress =
        await deploymentManager.getDeterministicDeploymentFactoryDeployer();

      // TODO: calculate required funds
      const txRequest = {
        to: senderAddress,
        value: (
          await deploymentManager.getDeterministicDeploymentFactoryFunding()
        ).toHexString(),
        gasPrice: options.gasPrice,
        maxFeePerGas: options.maxFeePerGas,
        maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      };
      await setupGasPrice(txRequest);
      await setupNonce(from, txRequest);

      if (unknown) {
        throw new UnknownSignerError({
          from,
          ...txRequest,
        });
      }

      if (options.log || hardwareWallet) {
        print(
          `sending eth to create2 contract deployer address (${senderAddress})`
        );
        if (hardwareWallet) {
          print(` (please confirm on your ${hardwareWallet})`);
        }
      }

      let ethTx = await handleSpecificErrors(
        ethersSigner.sendTransaction(txRequest)
      );
      if (options.log || hardwareWallet) {
        log(` (tx: ${ethTx.hash})...`);
      }
      ethTx = await onPendingTx(ethTx);
      await ethTx.wait();

      if (options.log || hardwareWallet) {
        print(
          `deploying create2 deployer contract (at ${create2DeployerAddress}) using deterministic deployment (https://github.com/Arachnid/deterministic-deployment-proxy)`
        );
        if (hardwareWallet) {
          print(` (please confirm on your ${hardwareWallet})`);
        }
      }
      const deployTx = await provider.sendTransaction(
        await deploymentManager.getDeterministicDeploymentFactoryDeploymentTx()
      );
      if (options.log || hardwareWallet) {
        log(` (tx: ${deployTx.hash})...`);
      }
      await deployTx.wait();
    }
    return create2DeployerAddress;
  }

  async function getArtifactFromOptions(
    name: string,
    options: DeployOptions
  ): Promise<{
    artifact: Artifact;
    artifactName?: string;
  }> {
    let artifact: Artifact;
    let artifactName: string | undefined;
    if (options.contract) {
      if (typeof options.contract === 'string') {
        artifactName = options.contract;
        artifact = await getArtifact(artifactName);
      } else {
        artifact = options.contract as Artifact; // TODO better handling
      }
    } else {
      artifactName = name;
      artifact = await getArtifact(artifactName);
    }
    return {artifact, artifactName};
  }

  async function getLinkedArtifact(
    name: string,
    options: DeployOptions
  ): Promise<{artifact: Artifact; artifactName: string | undefined}> {
    // TODO get linked artifact
    const {artifact, artifactName} = await getArtifactFromOptions(
      name,
      options
    );
    const byteCode = linkLibraries(artifact, options.libraries);
    return {artifact: {...artifact, bytecode: byteCode}, artifactName};
  }

  async function _deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    const args: any[] = options.args ? [...options.args] : [];
    await init();
    const {
      address: from,
      ethersSigner,
      hardwareWallet,
      unknown,
    } = getFrom(options.from);

    const {artifact: linkedArtifact, artifactName} = await getLinkedArtifact(
      name,
      options
    );

    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice,
      maxFeePerGas: options.maxFeePerGas,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      value: options.value,
      nonce: options.nonce,
    };

    const factory = new ContractFactory(
      linkedArtifact.abi,
      linkedArtifact.bytecode,
      ethersSigner
    );
    const numArguments = factory.interface.deploy.inputs.length;
    if (args.length !== numArguments) {
      throw new Error(
        `expected ${numArguments} constructor arguments, got ${args.length}`
      );
    }
    const unsignedTx = factory.getDeployTransaction(...args, overrides);

    let create2Address;
    if (options.deterministicDeployment) {
      if (typeof unsignedTx.data === 'string') {
        const create2DeployerAddress = await ensureCreate2DeployerReady(
          options
        );
        const create2Salt =
          typeof options.deterministicDeployment === 'string'
            ? hexlify(zeroPad(options.deterministicDeployment, 32))
            : '0x0000000000000000000000000000000000000000000000000000000000000000';
        create2Address = getCreate2Address(
          create2DeployerAddress,
          create2Salt,
          unsignedTx.data
        );
        unsignedTx.to = create2DeployerAddress;

        unsignedTx.data = create2Salt + unsignedTx.data.slice(2);
      } else {
        throw new Error('unsigned tx data as bytes not supported');
      }
    }

    await overrideGasLimit(unsignedTx, options, (newOverrides) =>
      ethersSigner.estimateGas(newOverrides)
    );
    await setupGasPrice(unsignedTx);
    await setupNonce(from, unsignedTx);

    if (unknown) {
      throw new UnknownSignerError({
        from,
        ...JSON.parse(JSON.stringify(unsignedTx)),
      });
    }

    if (options.log || hardwareWallet) {
      print(`deploying "${name}"`);
      if (hardwareWallet) {
        print(` (please confirm on your ${hardwareWallet})`);
      }
    }
    let tx = await handleSpecificErrors(
      ethersSigner.sendTransaction(unsignedTx)
    );

    if (options.log || hardwareWallet) {
      print(` (tx: ${tx.hash})...`);
    }

    if (options.autoMine) {
      try {
        await provider.send('evm_mine', []);
      } catch (e) {}
    }

    let preDeployment = {
      ...linkedArtifact,
      transactionHash: tx.hash,
      args,
      linkedData: options.linkedData,
    };
    if (artifactName && willSaveToDisk()) {
      const extendedArtifact = await partialExtension.getExtendedArtifact(
        artifactName
      );
      preDeployment = {
        ...extendedArtifact,
        ...preDeployment,
      };
    }
    tx = await onPendingTx(tx, name, preDeployment);
    const receipt = await tx.wait(options.waitConfirmations);
    const address =
      options.deterministicDeployment && create2Address
        ? create2Address
        : receipt.contractAddress;
    const deployment = {
      ...preDeployment,
      address,
      receipt,
      transactionHash: receipt.transactionHash,
      libraries: options.libraries,
    };
    await saveDeployment(name, deployment);
    if (options.log || hardwareWallet) {
      print(
        `: deployed at ${deployment.address} with ${receipt?.gasUsed} gas\n`
      );
    }
    return {
      ...deployment,
      address,
      newlyDeployed: true,
    };
  }

  async function deterministic(
    name: string,
    options: Create2DeployOptions
  ): Promise<{
    address: Address;
    implementationAddress?: Address;
    deploy: () => Promise<DeployResult>;
  }> {
    options = {...options}; // ensure no change
    await init();

    const deployFunction = () =>
      deploy(name, {
        ...options,
        deterministicDeployment: options.salt || true,
      });
    if (options.proxy) {
      /* eslint-disable prefer-const */
      let {
        viaAdminContract,
        proxyAdminDeployed,
        proxyAdminName,
        proxyAdminContract,
        owner,
        proxyAdmin,
        currentProxyAdminOwner,
        artifact,
        implementationArgs,
        implementationName,
        implementationOptions,
        proxyName,
        proxyContract,
        mergedABI,
        updateMethod,
        updateArgs,
      } = await _getProxyInfo(name, options);
      /* eslint-enable prefer-const */

      const {address: implementationAddress} = await deterministic(
        implementationName,
        {...implementationOptions, salt: options.salt}
      );

      const implementationContract = new Contract(
        implementationAddress,
        artifact.abi
      );

      let data = '0x';
      if (updateMethod) {
        updateArgs = updateArgs || [];
        if (!implementationContract[updateMethod]) {
          throw new Error(
            `contract need to implement function ${updateMethod}`
          );
        }
        const txData = await implementationContract.populateTransaction[
          updateMethod
        ](...updateArgs);
        data = txData.data || '0x';
      }

      if (viaAdminContract) {
        if (!proxyAdminName) {
          throw new Error(
            `no proxy admin name even though viaAdminContract is not undefined`
          );
        }

        if (!proxyAdminDeployed) {
          const {address: proxyAdminAddress} = await deterministic(
            proxyAdminName,
            {
              from: options.from,
              autoMine: options.autoMine,
              estimateGasExtra: options.estimateGasExtra,
              estimatedGasLimit: options.estimatedGasLimit,
              gasPrice: options.gasPrice,
              maxFeePerGas: options.maxFeePerGas,
              maxPriorityFeePerGas: options.maxPriorityFeePerGas,
              log: options.log,
              contract: proxyAdminContract,
              salt: options.salt,
              skipIfAlreadyDeployed: true,
              args: [owner],
              waitConfirmations: options.waitConfirmations,
            }
          );
          proxyAdmin = proxyAdminAddress;
        } else {
          proxyAdmin = proxyAdminDeployed.address;
        }
      }

      const proxyOptions = {...options}; // ensure no change
      delete proxyOptions.proxy;
      delete proxyOptions.libraries;
      proxyOptions.contract = proxyContract;
      proxyOptions.args = [implementationAddress, proxyAdmin, data];
      const {address: proxyAddress} = await deterministic(proxyName, {
        ...proxyOptions,
        salt: options.salt,
      });

      return {
        address: proxyAddress,
        implementationAddress,
        deploy: deployFunction,
      };
    } else {
      const args: any[] = options.args ? [...options.args] : [];
      const {ethersSigner, unknown, address: from} = getFrom(options.from);

      const artifactInfo = await getArtifactFromOptions(name, options);
      const {artifact} = artifactInfo;
      const abi = artifact.abi;
      const byteCode = linkLibraries(artifact, options.libraries);
      const factory = new ContractFactory(abi, byteCode, ethersSigner);

      const numArguments = factory.interface.deploy.inputs.length;
      if (args.length !== numArguments) {
        throw new Error(
          `expected ${numArguments} constructor arguments, got ${args.length}`
        );
      }

      const unsignedTx = factory.getDeployTransaction(...args);

      if (unknown) {
        throw new UnknownSignerError({
          from,
          ...JSON.parse(JSON.stringify(unsignedTx)),
        });
      }

      if (typeof unsignedTx.data !== 'string') {
        throw new Error('unsigned tx data as bytes not supported');
      } else {
        return {
          address: getCreate2Address(
            await deploymentManager.getDeterministicDeploymentFactoryAddress(),
            options.salt
              ? hexlify(zeroPad(options.salt, 32))
              : '0x0000000000000000000000000000000000000000000000000000000000000000',
            unsignedTx.data
          ),
          deploy: () =>
            deploy(name, {
              ...options,
              deterministicDeployment: options.salt || true,
            }),
        };
      }
    }
  }

  function getDeployment(name: string): Promise<Deployment> {
    return partialExtension.get(name);
  }

  function getDeploymentOrNUll(name: string): Promise<Deployment | null> {
    return partialExtension.getOrNull(name);
  }

  async function fetchIfDifferent(
    name: string,
    options: DeployOptions
  ): Promise<{differences: boolean; address?: string}> {
    options = {...options}; // ensure no change
    const argArray = options.args ? [...options.args] : [];
    await init();

    if (options.deterministicDeployment) {
      const {ethersSigner} = getFrom(options.from);

      const artifactInfo = await getArtifactFromOptions(name, options);
      const {artifact} = artifactInfo;
      const abi = artifact.abi;
      const byteCode = linkLibraries(artifact, options.libraries);
      const factory = new ContractFactory(abi, byteCode, ethersSigner);

      const numArguments = factory.interface.deploy.inputs.length;
      if (argArray.length !== numArguments) {
        throw new Error(
          `expected ${numArguments} constructor arguments, got ${argArray.length}`
        );
      }

      const unsignedTx = factory.getDeployTransaction(...argArray);
      if (typeof unsignedTx.data === 'string') {
        const create2Salt =
          typeof options.deterministicDeployment === 'string'
            ? hexlify(zeroPad(options.deterministicDeployment, 32))
            : '0x0000000000000000000000000000000000000000000000000000000000000000';
        const create2DeployerAddress =
          await deploymentManager.getDeterministicDeploymentFactoryAddress();
        const create2Address = getCreate2Address(
          create2DeployerAddress,
          create2Salt,
          unsignedTx.data
        );
        const code = await provider.getCode(create2Address);
        if (code === '0x') {
          return {differences: true, address: undefined};
        } else {
          return {differences: false, address: create2Address};
        }
      } else {
        throw new Error('unsigned tx data as bytes not supported');
      }
    }
    const deployment = await partialExtension.getOrNull(name);
    if (deployment) {
      if (options.skipIfAlreadyDeployed) {
        return {differences: false, address: undefined}; // TODO check receipt, see below
      }
      // TODO transactionReceipt + check for status
      let transactionDetailsAvailable = false;
      let transaction;
      if (deployment.receipt) {
        transactionDetailsAvailable = !!deployment.receipt.transactionHash;
        transaction = await provider.getTransaction(
          deployment.receipt.transactionHash
        );
      } else if (deployment.transactionHash) {
        transactionDetailsAvailable = true;
        transaction = await provider.getTransaction(deployment.transactionHash);
      }

      if (transaction) {
        const {ethersSigner} = await getFrom(options.from);
        const {artifact} = await getArtifactFromOptions(name, options);
        const abi = artifact.abi;
        const byteCode = linkLibraries(artifact, options.libraries);
        const factory = new ContractFactory(abi, byteCode, ethersSigner);
        const newTransaction = factory.getDeployTransaction(...argArray);
        const newData = newTransaction.data?.toString();

        if (transaction.data !== newData) {
          return {differences: true, address: deployment.address};
        }
        return {differences: false, address: deployment.address};
      } else {
        if (transactionDetailsAvailable) {
          throw new Error(
            `cannot get the transaction for ${name}'s previous deployment, please check your node synced status.`
          );
        } else {
          console.error(
            `no transaction details found for ${name}'s previous deployment, if the deployment is t be discarded, please delete the file`
          );
          return {differences: false, address: deployment.address};
        }
      }
    }
    return {differences: true, address: undefined};
  }

  async function _deployOne(
    name: string,
    options: DeployOptions,
    failsOnExistingDeterminisitc?: boolean
  ): Promise<DeployResult> {
    const argsArray = options.args ? [...options.args] : [];
    options = {...options, args: argsArray};

    let result: DeployResult;
    const diffResult = await fetchIfDifferent(name, options);
    if (diffResult.differences) {
      result = await _deploy(name, options);
    } else {
      if (failsOnExistingDeterminisitc && options.deterministicDeployment) {
        throw new Error(
          `already deployed on same deterministic address: ${diffResult.address}`
        );
      }
      const deployment = await getDeploymentOrNUll(name);
      if (deployment) {
        if (
          options.deterministicDeployment &&
          diffResult.address &&
          diffResult.address.toLowerCase() !== deployment.address.toLowerCase()
        ) {
          const {artifact: linkedArtifact, artifactName} =
            await getLinkedArtifact(name, options);

          // receipt missing
          const newDeployment = {
            ...linkedArtifact,
            address: diffResult.address,
            linkedData: options.linkedData,
            libraries: options.libraries,
            args: argsArray,
          };
          await saveDeployment(name, newDeployment, artifactName);
          result = {
            ...newDeployment,
            newlyDeployed: false,
          };
        } else {
          result = deployment as DeployResult;
          result.newlyDeployed = false;
        }
      } else {
        if (!diffResult.address) {
          throw new Error(
            'no differences found but no address, this should be impossible'
          );
        }

        const {artifact: linkedArtifact, artifactName} =
          await getLinkedArtifact(name, options);

        // receipt missing
        const newDeployment = {
          ...linkedArtifact,
          address: diffResult.address,
          linkedData: options.linkedData,
          libraries: options.libraries,
          args: argsArray,
        };
        await saveDeployment(name, newDeployment, artifactName);
        result = {
          ...newDeployment,
          newlyDeployed: false,
        };
      }
      if (options.log) {
        log(`reusing "${name}" at ${result.address}`);
      }
    }

    return result;
  }

  function _checkUpgradeIndex(
    oldDeployment: Deployment | null,
    upgradeIndex?: number
  ): DeployResult | undefined {
    if (typeof upgradeIndex === 'undefined') {
      return;
    }
    if (upgradeIndex === 0) {
      if (oldDeployment) {
        return {...oldDeployment, newlyDeployed: false};
      }
    } else if (upgradeIndex === 1) {
      if (!oldDeployment) {
        throw new Error(
          'upgradeIndex === 1 : expects Deployments to already exists'
        );
      }
      if (oldDeployment.history && oldDeployment.history.length > 0) {
        return {...oldDeployment, newlyDeployed: false};
      }
    } else {
      if (!oldDeployment) {
        throw new Error(
          `upgradeIndex === ${upgradeIndex} : expects Deployments to already exists`
        );
      }
      if (!oldDeployment.history) {
        throw new Error(
          `upgradeIndex > 1 : expects Deployments history to exists`
        );
      } else if (oldDeployment.history.length > upgradeIndex - 1) {
        return {...oldDeployment, newlyDeployed: false};
      } else if (oldDeployment.history.length < upgradeIndex - 1) {
        throw new Error(
          `upgradeIndex === ${upgradeIndex} : expects Deployments history length to be at least ${
            upgradeIndex - 1
          }`
        );
      }
    }
  }

  async function _getProxyInfo(
    name: string,
    options: DeployOptions
  ): Promise<{
    viaAdminContract:
      | string
      | {name: string; artifact?: string | ArtifactData}
      | undefined;
    proxyAdminName: string | undefined;
    proxyAdminDeployed: Deployment | undefined;
    proxyAdmin: string;
    proxyAdminContract: ExtendedArtifact | undefined;
    owner: string;
    currentProxyAdminOwner: string | undefined;
    artifact: ExtendedArtifact;
    implementationArgs: any[];
    implementationName: string;
    implementationOptions: DeployOptions;
    mergedABI: ABI;
    proxyName: string;
    proxyContract: ExtendedArtifact;
    oldDeployment: Deployment | null;
    updateMethod: string | undefined;
    updateArgs: any[];
    upgradeIndex: number | undefined;
  }> {
    const oldDeployment = await getDeploymentOrNUll(name);
    let updateMethod: string | undefined;
    let updateArgs: any[] | undefined;
    let upgradeIndex;
    let proxyContract: ExtendedArtifact = eip173Proxy;
    let checkABIConflict = true;
    let viaAdminContract:
      | string
      | {name: string; artifact?: string | ArtifactData}
      | undefined;
    if (typeof options.proxy === 'object') {
      upgradeIndex = options.proxy.upgradeIndex;
      if ('methodName' in options.proxy) {
        updateMethod = options.proxy.methodName;
        if ('execute' in options.proxy) {
          throw new Error(
            `cannot have both "methodName" and "execute" options for proxy`
          );
        }
      } else if ('execute' in options.proxy && options.proxy.execute) {
        if ('methodName' in options.proxy.execute) {
          updateMethod = options.proxy.execute.methodName;
          updateArgs = options.proxy.execute.args;
          if (
            'init' in options.proxy.execute ||
            'onUpgrade' in options.proxy.execute
          ) {
            throw new Error(
              `cannot have both "methodName" and ("onUpgrade" or "init") options for proxy.execute`
            );
          }
        } else if (
          ('init' in options.proxy.execute && options.proxy.execute.init) ||
          ('onUpgrade' in options.proxy.execute &&
            options.proxy.execute.onUpgrade)
        ) {
          if (oldDeployment) {
            updateMethod = options.proxy.execute.onUpgrade?.methodName;
            updateArgs = options.proxy.execute.onUpgrade?.args;
          } else {
            updateMethod = options.proxy.execute.init.methodName;
            updateArgs = options.proxy.execute.init.args;
          }
        }
      }

      if (options.proxy.proxyContract) {
        if (typeof options.proxy.proxyContract === 'string') {
          try {
            proxyContract = await partialExtension.getExtendedArtifact(
              options.proxy.proxyContract
            );
          } catch (e) {}
          if (!proxyContract || proxyContract === eip173Proxy) {
            if (options.proxy.proxyContract === 'EIP173ProxyWithReceive') {
              proxyContract = eip173ProxyWithReceive;
            } else if (options.proxy.proxyContract === 'EIP173Proxy') {
              proxyContract = eip173Proxy;
            } else if (
              options.proxy.proxyContract === 'OpenZeppelinTransparentProxy'
            ) {
              checkABIConflict = false;
              proxyContract = OpenZeppelinTransparentProxy;
              viaAdminContract = 'DefaultProxyAdmin';
            } else if (
              options.proxy.proxyContract === 'OptimizedTransparentProxy'
            ) {
              checkABIConflict = false;
              proxyContract = OptimizedTransparentUpgradeableProxy;
              viaAdminContract = 'DefaultProxyAdmin';
            } else {
              throw new Error(
                `no contract found for ${options.proxy.proxyContract}`
              );
            }
          }
        }
      }
      if (options.proxy.viaAdminContract) {
        viaAdminContract = options.proxy.viaAdminContract;
      }
    } else if (typeof options.proxy === 'string') {
      updateMethod = options.proxy;
    }

    const proxyName = name + '_Proxy';
    const {address: owner} = getProxyOwner(options);
    const {address: from} = getFrom(options.from);
    const implementationArgs = options.args ? [...options.args] : [];

    // --- Implementation Deployment ---
    const implementationName = name + '_Implementation';
    const implementationOptions = {
      contract: options.contract || name,
      from: options.from,
      autoMine: options.autoMine,
      estimateGasExtra: options.estimateGasExtra,
      estimatedGasLimit: options.estimatedGasLimit,
      gasPrice: options.gasPrice,
      maxFeePerGas: options.maxFeePerGas,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas,
      log: options.log,
      deterministicDeployment: options.deterministicDeployment,
      libraries: options.libraries,
      linkedData: options.linkedData,
      args: implementationArgs,
      skipIfAlreadyDeployed: options.skipIfAlreadyDeployed,
      waitConfirmations: options.waitConfirmations,
    };

    const {artifact} = await getArtifactFromOptions(
      name,
      implementationOptions
    );

    const proxyContractConstructor = proxyContract.abi.find(
      (v) => v.type === 'constructor'
    );
    // ensure no clash
    const mergedABI = mergeABIs([proxyContract.abi, artifact.abi], {
      check: checkABIConflict, // TODO options for custom proxy ?
      skipSupportsInterface: true, // TODO options for custom proxy ?
    }).filter((v) => v.type !== 'constructor');
    mergedABI.push(proxyContractConstructor); // use proxy constructor abi

    const constructor = artifact.abi.find(
      (fragment: {type: string; inputs: any[]}) =>
        fragment.type === 'constructor'
    );

    if (
      (!constructor && implementationArgs.length > 0) ||
      (constructor && constructor.inputs.length !== implementationArgs.length)
    ) {
      throw new Error(
        `The number of arguments passed to not match the number of argument in the implementation constructor.
Please specify the correct number of arguments as part of the deploy options: "args"`
      );
    }

    if (updateMethod) {
      const updateMethodFound: {
        type: string;
        inputs: any[];
        name: string;
      } = artifact.abi.find(
        (fragment: {type: string; inputs: any[]; name: string}) =>
          fragment.type === 'function' && fragment.name === updateMethod
      );
      if (!updateMethodFound) {
        throw new Error(`contract need to implement function ${updateMethod}`);
      }

      if (!updateArgs) {
        if (implementationArgs.length === updateMethodFound.inputs.length) {
          updateArgs = implementationArgs;
        } else {
          throw new Error(
            `
If only the methodName (and no args) is specified for proxy deployment, the arguments used for the implementation contract will be reused for the update method.
This allow your contract to both be deployed directly and deployed via proxy.

Currently your contract implementation's constructor do not have the same number of arguments as the update method.
You can either changes the contract or use the "execute" options and specify different arguments for the update method.
Note that in this case, the contract deployment will not behave the same if deployed without proxy.
    `
          );
        }
      }
    }

    // this avoid typescript error, but should not be necessary at runtime
    if (!updateArgs) {
      updateArgs = implementationArgs;
    }

    let proxyAdminName: string | undefined;
    const proxyAdmin = owner;
    let currentProxyAdminOwner: string | undefined;
    let proxyAdminDeployed: Deployment | undefined;
    let proxyAdminContract: ExtendedArtifact | undefined;
    if (viaAdminContract) {
      let proxyAdminArtifactNameOrContract: string | ArtifactData | undefined;
      if (typeof viaAdminContract === 'string') {
        proxyAdminName = viaAdminContract;
        proxyAdminArtifactNameOrContract = viaAdminContract;
      } else {
        proxyAdminName = viaAdminContract.name;
        if (!viaAdminContract.artifact) {
          proxyAdminDeployed = await partialExtension.get(proxyAdminName);
        }
        proxyAdminArtifactNameOrContract = viaAdminContract.artifact;
      }

      if (typeof proxyAdminArtifactNameOrContract === 'string') {
        try {
          proxyAdminContract = await partialExtension.getExtendedArtifact(
            proxyAdminArtifactNameOrContract
          );
        } catch (e) {}

        if (!proxyAdminContract) {
          if (viaAdminContract === 'DefaultProxyAdmin') {
            proxyAdminContract = DefaultProxyAdmin;
          } else {
            throw new Error(
              `no contract found for ${proxyAdminArtifactNameOrContract}`
            );
          }
        }
      } else {
        proxyAdminContract = proxyAdminArtifactNameOrContract;
      }
    }

    return {
      proxyName,
      proxyContract,
      mergedABI,
      viaAdminContract,
      proxyAdminDeployed,
      proxyAdminName,
      proxyAdminContract,
      owner,
      proxyAdmin,
      currentProxyAdminOwner,
      artifact,
      implementationArgs,
      implementationName,
      implementationOptions,
      oldDeployment,
      updateMethod,
      updateArgs,
      upgradeIndex,
    };
  }

  // TODO rename
  async function _deployViaEIP173Proxy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    /* eslint-disable prefer-const */
    let {
      oldDeployment,
      updateMethod,
      updateArgs,
      upgradeIndex,
      viaAdminContract,
      proxyAdminDeployed,
      proxyAdminName,
      proxyAdminContract,
      owner,
      proxyAdmin,
      currentProxyAdminOwner,
      artifact,
      implementationArgs,
      implementationName,
      implementationOptions,
      proxyName,
      proxyContract,
      mergedABI,
    } = await _getProxyInfo(name, options);
    /* eslint-enable prefer-const */

    const deployResult = _checkUpgradeIndex(oldDeployment, upgradeIndex);
    if (deployResult) {
      return deployResult;
    }

    if (viaAdminContract) {
      if (!proxyAdminName) {
        throw new Error(
          `no proxy admin name even though viaAdminContract is not undefined`
        );
      }
      if (!proxyAdminDeployed) {
        proxyAdminDeployed = await _deployOne(proxyAdminName, {
          from: options.from,
          autoMine: options.autoMine,
          estimateGasExtra: options.estimateGasExtra,
          estimatedGasLimit: options.estimatedGasLimit,
          gasPrice: options.gasPrice,
          maxFeePerGas: options.maxFeePerGas,
          maxPriorityFeePerGas: options.maxPriorityFeePerGas,
          log: options.log,
          contract: proxyAdminContract,
          deterministicDeployment: options.deterministicDeployment,
          skipIfAlreadyDeployed: true,
          args: [owner],
          waitConfirmations: options.waitConfirmations,
        });
      }

      proxyAdmin = proxyAdminDeployed.address;
      currentProxyAdminOwner = (await read(proxyAdminName, 'owner')) as string;

      if (currentProxyAdminOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(
          `To change owner/admin, you need to call transferOwnership on ${proxyAdminName}`
        );
      }
      if (currentProxyAdminOwner === AddressZero) {
        throw new Error(
          `The Proxy Admin (${proxyAdminName}) belongs to no-one. The Proxy cannot be upgraded anymore`
        );
      }
    }

    const implementation = await _deployOne(
      implementationName,
      implementationOptions
    );

    if (!oldDeployment || implementation.newlyDeployed) {
      // console.log(`implementation deployed at ${implementation.address} for ${implementation.receipt.gasUsed}`);
      const implementationContract = new Contract(
        implementation.address,
        implementation.abi
      );

      let data = '0x';
      if (updateMethod) {
        if (!implementationContract[updateMethod]) {
          throw new Error(
            `contract need to implement function ${updateMethod}`
          );
        }
        const txData = await implementationContract.populateTransaction[
          updateMethod
        ](...updateArgs);
        data = txData.data || '0x';
      }

      let proxy = await getDeploymentOrNUll(proxyName);
      if (!proxy) {
        const proxyOptions = {...options}; // ensure no change
        delete proxyOptions.proxy;
        delete proxyOptions.libraries;
        proxyOptions.contract = proxyContract;
        proxyOptions.args = [implementation.address, proxyAdmin, data];
        proxy = await _deployOne(proxyName, proxyOptions, true);
        // console.log(`proxy deployed at ${proxy.address} for ${proxy.receipt.gasUsed}`);
      } else {
        const ownerStorage = await provider.getStorageAt(
          proxy.address,
          '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
        );
        const currentOwner = getAddress(`0x${ownerStorage.substr(-40)}`);

        const oldProxy = proxy.abi.find(
          (frag: {name: string}) => frag.name === 'changeImplementation'
        );
        const changeImplementationMethod = oldProxy
          ? 'changeImplementation'
          : 'upgradeToAndCall';

        if (currentOwner.toLowerCase() !== proxyAdmin.toLowerCase()) {
          throw new Error(
            `To change owner/admin, you need to call the proxy directly`
          );
        }
        if (currentOwner === AddressZero) {
          throw new Error(
            'The Proxy belongs to no-one. It cannot be upgraded anymore'
          );
        }

        if (proxyAdminName) {
          if (oldProxy) {
            throw new Error(`Old Proxy do not support Proxy Admin contracts`);
          }
          if (!currentProxyAdminOwner) {
            throw new Error(`no currentProxyAdminOwner found in ProxyAdmin`);
          }

          let executeReceipt;
          if (updateMethod) {
            executeReceipt = await execute(
              proxyAdminName,
              {...options, from: currentProxyAdminOwner},
              'upgradeAndCall',
              proxy.address,
              implementation.address,
              data
            );
          } else {
            executeReceipt = await execute(
              proxyAdminName,
              {...options, from: currentProxyAdminOwner},
              'upgrade',
              proxy.address,
              implementation.address
            );
          }
          if (!executeReceipt) {
            throw new Error(`could not execute ${changeImplementationMethod}`);
          }
        } else {
          let executeReceipt;
          if (
            changeImplementationMethod === 'upgradeToAndCall' &&
            !updateMethod
          ) {
            executeReceipt = await execute(
              proxyName,
              {...options, from: currentOwner},
              'upgradeTo',
              implementation.address
            );
          } else {
            executeReceipt = await execute(
              proxyName,
              {...options, from: currentOwner},
              changeImplementationMethod,
              implementation.address,
              data
            );
          }

          if (!executeReceipt) {
            throw new Error(`could not execute ${changeImplementationMethod}`);
          }
        }
      }
      const proxiedDeployment: DeploymentSubmission = {
        ...proxyContract,
        receipt: proxy.receipt,
        address: proxy.address,
        linkedData: options.linkedData,
        abi: mergedABI,
        implementation: implementation.address,
        args: proxy.args,
        execute: updateMethod
          ? {
              methodName: updateMethod,
              args: updateArgs,
            }
          : undefined,
      };
      if (oldDeployment) {
        proxiedDeployment.history = proxiedDeployment.history
          ? proxiedDeployment.history.concat([oldDeployment])
          : [oldDeployment];
      }
      await saveDeployment(name, proxiedDeployment);

      const deployment = await partialExtension.get(name);
      return {
        ...deployment,
        newlyDeployed: true,
      };
    } else {
      if (oldDeployment.implementation !== implementation.address) {
        const proxiedDeployment: DeploymentSubmission = {
          ...oldDeployment,
          implementation: implementation.address,
          linkedData: options.linkedData,
          abi: mergedABI,
          execute: updateMethod
            ? {
                methodName: updateMethod,
                args: updateArgs,
              }
            : undefined,
        };
        proxiedDeployment.history = proxiedDeployment.history
          ? proxiedDeployment.history.concat([oldDeployment])
          : [oldDeployment];
        await saveDeployment(name, proxiedDeployment);
      }

      const deployment = await partialExtension.get(name);
      return {
        ...deployment,
        newlyDeployed: false,
      };
    }
  }

  function getProxyOwner(options: DeployOptions) {
    let address = options.from; // admim default to msg.sender
    if (typeof options.proxy === 'object') {
      address = options.proxy.owner || address;
    }
    return getFrom(address);
  }

  function getDiamondOwner(options: DiamondOptions) {
    let address = options.from; // admim default to msg.sender
    address = options.owner || address;
    return getFrom(address);
  }

  function getOptionalFrom(from?: string): {
    address?: Address;
    ethersSigner?: Signer;
    hardwareWallet?: string;
  } {
    if (!from) {
      return {
        address: from,
        ethersSigner: undefined,
        hardwareWallet: undefined,
      };
    }
    return getFrom(from);
  }

  function getFrom(from: string): {
    address: Address;
    ethersSigner: Signer;
    hardwareWallet?: string;
    unknown: boolean;
  } {
    let ethersSigner: Signer | undefined;
    let hardwareWallet: string | undefined = undefined;
    let unknown = false;

    if (from.length >= 64) {
      if (from.length === 64) {
        from = '0x' + from;
      }
      const wallet = new Wallet(from, provider);
      from = wallet.address;
      ethersSigner = wallet;
    } else {
      if (availableAccounts[from.toLowerCase()]) {
        ethersSigner = provider.getSigner(from);
      } else {
        // TODO register protocol based account as availableAccounts ? if so do not else here
        const registeredProtocol =
          deploymentManager.addressesToProtocol[from.toLowerCase()];
        if (registeredProtocol) {
          if (registeredProtocol === 'ledger') {
            if (!LedgerSigner) {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const hardwareWalletModule = require('@ethersproject/hardware-wallets');
              LedgerSigner = hardwareWalletModule.LedgerSigner;
            }
            ethersSigner = new LedgerSigner(provider);
            hardwareWallet = 'ledger';
          } else if (registeredProtocol.startsWith('privatekey')) {
            ethersSigner = new Wallet(registeredProtocol.substr(13), provider);
          } else if (registeredProtocol.startsWith('gnosis')) {
            ethersSigner = new Wallet(registeredProtocol.substr(13), provider);
          }
        }
      }
    }

    if (!ethersSigner) {
      unknown = true;
      ethersSigner = provider.getSigner(from);
    }

    return {address: from, ethersSigner, hardwareWallet, unknown};
  }

  // async function findEvents(contract: Contract, event: string, blockHash: string): Promise<any[]> {
  //   // TODO type the return type
  //   const filter = contract.filters[event]();
  //   const events = await contract.queryFilter(filter, blockHash);
  //   return events;
  // }

  function sigsFromABI(abi: any[]): string[] {
    return abi
      .filter((fragment: any) => fragment.type === 'function')
      .map((fragment: any) =>
        Interface.getSighash(FunctionFragment.from(fragment))
      );
  }

  async function _deployViaDiamondProxy(
    name: string,
    options: DiamondOptions
  ): Promise<DeployResult> {
    const oldDeployment = await getDeploymentOrNUll(name);
    let proxy: Deployment | undefined;
    const deployResult = _checkUpgradeIndex(
      oldDeployment,
      options.upgradeIndex
    );
    if (deployResult) {
      return deployResult;
    }

    if (options.deterministicSalt) {
      throw new Error(`diamond determinsitc deployment not implemented yet`);
      // need to compute the resulting address accurately
    }

    const proxyName = name + '_DiamondProxy';
    const {address: owner, hardwareWallet} = getDiamondOwner(options);
    const newSelectors: string[] = [];
    const facetSnapshot: Facet[] = [];
    const oldFacets: Facet[] = [];
    const selectorToNotTouch: {[selector: string]: boolean} = {};
    for (const selector of [
      '0xcdffacc6',
      '0x52ef6b2c',
      '0xadfca15e',
      '0x7a0ed627',
      '0x01ffc9a7',
      '0x1f931c1c',
      '0xf2fde38b',
      '0x8da5cb5b',
    ]) {
      selectorToNotTouch[selector] = true;
    }
    if (oldDeployment) {
      proxy = await getDeployment(proxyName);
      const diamondProxy = new Contract(proxy.address, proxy.abi, provider);

      const currentFacets: Facet[] = await diamondProxy.facets();
      for (const currentFacet of currentFacets) {
        oldFacets.push(currentFacet);

        // ensure DiamondLoupeFacet, OwnershipFacet and DiamondCutFacet are kept // TODO options to delete cut them out?
        if (
          findAll(
            [
              '0xcdffacc6',
              '0x52ef6b2c',
              '0xadfca15e',
              '0x7a0ed627',
              '0x01ffc9a7',
            ],
            currentFacet.functionSelectors
          ) || // Loupe
          currentFacet.functionSelectors[0] === '0x1f931c1c' || // DiamoncCut
          findAll(['0xf2fde38b', '0x8da5cb5b'], currentFacet.functionSelectors) // ERC173
        ) {
          facetSnapshot.push(currentFacet);
          newSelectors.push(...currentFacet.functionSelectors);
        }
      }
    }
    // console.log({ oldFacets: JSON.stringify(oldFacets, null, "  ") });

    let changesDetected = !oldDeployment;
    let abi: any[] = diamondBase.abi.concat([]);
    const facetCuts: FacetCut[] = [];
    for (const facet of options.facets) {
      const artifact = await getArtifact(facet); // TODO getArtifactFromOptions( // allowing to pass bytecode / abi
      const constructor = artifact.abi.find(
        (fragment: {type: string; inputs: any[]}) =>
          fragment.type === 'constructor'
      );
      if (constructor && constructor.inputs.length > 0) {
        throw new Error(`Facet with constructor not yet supported`); // TODO remove that requirement
      }
      abi = mergeABIs([abi, artifact.abi], {
        check: true,
        skipSupportsInterface: false,
      });
      // TODO allow facet to be named so multiple version could coexist
      const implementation = await _deployOne(facet, {
        from: options.from,
        autoMine: options.autoMine,
        estimateGasExtra: options.estimateGasExtra,
        estimatedGasLimit: options.estimatedGasLimit,
        gasPrice: options.gasPrice,
        maxFeePerGas: options.maxFeePerGas,
        maxPriorityFeePerGas: options.maxPriorityFeePerGas,
        log: options.log,
        // deterministicDeployment: options.deterministicDeployment, // todo ?
        libraries: options.libraries,
        // fieldsToCompare: options.fieldsToCompare, // todo ?
        linkedData: options.linkedData,
        // args: options.args, // toDO ?
      });
      if (implementation.newlyDeployed) {
        // console.log(`facet ${facet} deployed at ${implementation.address}`);
        const newFacet = {
          facetAddress: implementation.address,
          functionSelectors: sigsFromABI(implementation.abi),
        };
        facetSnapshot.push(newFacet);
        newSelectors.push(...newFacet.functionSelectors);
      } else {
        const oldImpl = await getDeployment(facet);
        const newFacet = {
          facetAddress: oldImpl.address,
          functionSelectors: sigsFromABI(oldImpl.abi),
        };
        facetSnapshot.push(newFacet);
        newSelectors.push(...newFacet.functionSelectors);
      }
    }

    const oldSelectors: string[] = [];
    const oldSelectorsFacetAddress: {[selector: string]: string} = {};
    for (const oldFacet of oldFacets) {
      for (const selector of oldFacet.functionSelectors) {
        oldSelectors.push(selector);
        oldSelectorsFacetAddress[selector] = oldFacet.facetAddress;
      }
    }

    for (const newFacet of facetSnapshot) {
      const selectorsToAdd: string[] = [];
      const selectorsToReplace: string[] = [];

      for (const selector of newFacet.functionSelectors) {
        if (oldSelectors.indexOf(selector) > 0) {
          if (
            oldSelectorsFacetAddress[selector].toLowerCase() !==
              newFacet.facetAddress.toLowerCase() &&
            !selectorToNotTouch[selector]
          ) {
            selectorsToReplace.push(selector);
          }
        } else {
          if (!selectorToNotTouch[selector]) {
            selectorsToAdd.push(selector);
          }
        }
      }

      if (selectorsToReplace.length > 0) {
        changesDetected = true;
        facetCuts.push({
          facetAddress: newFacet.facetAddress,
          functionSelectors: selectorsToReplace,
          action: FacetCutAction.Replace,
        });
      }

      if (selectorsToAdd.length > 0) {
        changesDetected = true;
        facetCuts.push({
          facetAddress: newFacet.facetAddress,
          functionSelectors: selectorsToAdd,
          action: FacetCutAction.Add,
        });
      }
    }

    const selectorsToDelete: string[] = [];
    for (const selector of oldSelectors) {
      if (newSelectors.indexOf(selector) === -1) {
        selectorsToDelete.push(selector);
      }
    }

    if (selectorsToDelete.length > 0) {
      changesDetected = true;
      facetCuts.unshift({
        facetAddress: '0x0000000000000000000000000000000000000000',
        functionSelectors: selectorsToDelete,
        action: FacetCutAction.Remove,
      });
    }

    let data = '0x';
    if (options.execute) {
      const diamondContract = new Contract(
        '0x0000000000000000000000000000000000000001',
        abi
      );
      const txData = await diamondContract.populateTransaction[
        options.execute.methodName
      ](...options.execute.args);
      data = txData.data || '0x';
    }

    if (changesDetected) {
      if (!proxy) {
        // ensure a Diamantaire exists on the network :
        const diamantaireName = 'Diamantaire';
        let diamantaireDeployment = await getDeploymentOrNUll(diamantaireName);
        diamantaireDeployment = await _deployOne(diamantaireName, {
          contract: diamantaire,
          from: options.from,
          deterministicDeployment: true,
          autoMine: options.autoMine,
          estimateGasExtra: options.estimateGasExtra,
          estimatedGasLimit: options.estimatedGasLimit,
          gasPrice: options.gasPrice,
          maxFeePerGas: options.maxFeePerGas,
          maxPriorityFeePerGas: options.maxPriorityFeePerGas,
          log: options.log,
        });
        const diamantaireContract = new Contract(
          diamantaireDeployment.address,
          diamantaire.abi,
          provider
        );
        // the diamantaire allow the execution of data at diamond construction time

        let deterministicDiamondAlreadyDeployed = false;
        let expectedAddress: string | undefined = undefined;
        let salt =
          '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (typeof options.deterministicSalt !== 'undefined') {
          if (typeof options.deterministicSalt === 'string') {
            if (options.deterministicSalt === salt) {
              throw new Error(
                `deterministicSalt cannot be 0x000..., it needs to be a non-zero bytes32 salt. This is to ensure you are explicitly specyfying different addresses for multiple diamonds`
              );
            } else {
              if (options.deterministicSalt.length !== 66) {
                throw new Error(
                  `deterministicSalt needs to be a string of 66 hexadecimal characters (including the 0x prefix)`
                );
              }
              salt = options.deterministicSalt;
              expectedAddress = getCreate2Address(
                diamantaireContract.address,
                solidityKeccak256(['bytes32', 'address'], [salt, owner]),
                diamondBase.bytecode +
                  '000000000000000000000000' +
                  diamantaireContract.address.slice(2)
              );
              const code = await provider.getCode(expectedAddress);
              if (code !== '0x') {
                deterministicDiamondAlreadyDeployed = true;
              }
            }
          } else {
            throw new Error(
              `deterministicSalt need to be a string, an non-zero bytes32 salt`
            );
          }
        }

        // this is with the default Diamantaire based on create2
        const builtinDiamondCut = [
          {
            // DiamondCutFacet
            facetAddress: '0x35d80a53f7be635f75152221d4d71cd4dcb07e5c',
            action: 0,
            functionSelectors: ['0x1f931c1c'],
          },
          {
            // DiamondLoupeFacet
            facetAddress: '0xc1bbdf9f8c0b6ae0b4d35e9a778080b691a72a3e',
            action: 0,
            functionSelectors: [
              '0xadfca15e',
              '0x7a0ed627',
              '0xcdffacc6',
              '0x52ef6b2c',
              '0x01ffc9a7',
            ],
          },
          {
            // OwnershipFacet
            facetAddress: '0xcfEe10af6C7A91863c2bbDbCCA3bCB5064A447BE',
            action: 0,
            functionSelectors: ['0xf2fde38b', '0x8da5cb5b'],
          },
        ];

        const diamondConstructorArgs = [
          builtinDiamondCut,
          {owner: diamantaireDeployment.address},
        ];

        if (expectedAddress && deterministicDiamondAlreadyDeployed) {
          proxy = {
            ...diamondBase,
            address: expectedAddress,
            args: diamondConstructorArgs,
          };
          await saveDeployment(proxyName, proxy);
        } else {
          const createReceipt = await execute(
            diamantaireName,
            options,
            'createDiamond',
            owner,
            facetCuts,
            data,
            salt
          );

          if (!createReceipt) {
            throw new Error(`failed to get receipt from diamond creation`);
          }

          const events = [];
          if (createReceipt.logs) {
            for (const l of createReceipt.logs) {
              try {
                events.push(diamantaireContract.interface.parseLog(l));
              } catch (e) {}
            }
          }

          const diamondCreatedEvent = events.find(
            (e) => e.name === 'DiamondCreated'
          );
          if (!diamondCreatedEvent) {
            throw new Error('DiamondCreated Not Emitted');
          }
          const proxyAddress = diamondCreatedEvent.args.diamond;
          if (options.log || hardwareWallet) {
            log(
              `Diamond deployed at ${proxyAddress} via Diamantaire (${diamantaireDeployment.address} (tx: ${createReceipt.transactionHash})) with ${createReceipt.gasUsed} gas`
            );
          }

          if (expectedAddress && expectedAddress !== proxyAddress) {
            throw new Error(
              `unexpected address ${proxyAddress} VS ${expectedAddress}`
            );
          }
          proxy = {
            ...diamondBase,
            address: proxyAddress,
            receipt: createReceipt,
            transactionHash: createReceipt.transactionHash,
            args: diamondConstructorArgs,
          };
          await saveDeployment(proxyName, proxy);
        }

        await saveDeployment(name, {
          ...diamondBase,
          args: proxy.args,
          address: proxy.address,
          receipt: proxy.receipt,
          transactionHash: proxy.transactionHash,
          linkedData: options.linkedData,
          facets: facetSnapshot,
          diamondCut: facetCuts,
          abi,
          execute: options.execute,
        });
      } else {
        if (!oldDeployment) {
          throw new Error(`Cannot find Deployment for ${name}`);
        }
        const currentOwner = await read(proxyName, 'owner');
        if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error(
            'To change owner, you need to call `transferOwnership`'
          );
        }
        if (currentOwner === AddressZero) {
          throw new Error(
            'The Diamond belongs to no-one. It cannot be upgraded anymore'
          );
        }

        const executeReceipt = await execute(
          name,
          {...options, from: currentOwner},
          'diamondCut',
          facetCuts,
          data === '0x'
            ? '0x0000000000000000000000000000000000000000'
            : proxy.address,
          data
        );
        if (!executeReceipt) {
          throw new Error('failed to execute');
        }
        await saveDeployment(name, {
          receipt: executeReceipt,
          transactionHash: executeReceipt.transactionHash,
          history: oldDeployment.history
            ? oldDeployment.history.concat(oldDeployment)
            : [oldDeployment],
          linkedData: options.linkedData,
          address: proxy.address,
          abi,
          facets: facetSnapshot,
          diamondCut: facetCuts,
          execute: options.execute,
        });
      }

      const deployment = await partialExtension.get(name);
      return {
        ...deployment,
        newlyDeployed: true,
      };
    } else {
      const oldDeployment = await partialExtension.get(name);

      const proxiedDeployment: DeploymentSubmission = {
        ...oldDeployment,
        facets: facetSnapshot,
        diamondCut: facetCuts,
        abi,
        execute: options.execute,
      };
      // TODO ?
      // proxiedDeployment.history = proxiedDeployment.history
      //   ? proxiedDeployment.history.concat([oldDeployment])
      //   : [oldDeployment];
      await saveDeployment(name, proxiedDeployment);

      const deployment = await partialExtension.get(name);
      return {
        ...deployment,
        newlyDeployed: false,
      };
    }
  }

  async function deploy(
    name: string,
    options: DeployOptions
  ): Promise<DeployResult> {
    options = {...options}; // ensure no change
    await init();
    if (!options.proxy) {
      return _deployOne(name, options);
    }
    return _deployViaEIP173Proxy(name, options);
  }

  async function diamond(
    name: string,
    options: DiamondOptions
  ): Promise<DeployResult> {
    options = {...options}; // ensure no change
    await init();
    return _deployViaDiamondProxy(name, options);
  }

  async function rawTx(tx: SimpleTx): Promise<Receipt> {
    tx = {...tx};
    await init();
    const {
      address: from,
      ethersSigner,
      hardwareWallet,
      unknown,
    } = getFrom(tx.from);

    const transactionData = {
      to: tx.to,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice ? BigNumber.from(tx.gasPrice) : undefined,
      maxFeePerGas: tx.maxFeePerGas
        ? BigNumber.from(tx.maxFeePerGas)
        : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas
        ? BigNumber.from(tx.maxPriorityFeePerGas)
        : undefined,
      value: tx.value ? BigNumber.from(tx.value) : undefined,
      nonce: tx.nonce,
      data: tx.data,
    };

    await overrideGasLimit(transactionData, tx, (newOverrides) =>
      ethersSigner.estimateGas(newOverrides)
    );
    await setupGasPrice(transactionData);
    await setupNonce(from, transactionData);

    if (unknown) {
      throw new UnknownSignerError({
        from,
        ...transactionData,
      });
    }

    if (hardwareWallet) {
      log(` please confirm on your ${hardwareWallet}`);
    }
    let pendingTx = await handleSpecificErrors(
      ethersSigner.sendTransaction(transactionData)
    );
    pendingTx = await onPendingTx(pendingTx);
    if (tx.autoMine) {
      try {
        await provider.send('evm_mine', []);
      } catch (e) {}
    }
    return pendingTx.wait();
  }

  async function catchUnknownSigner(
    action: Promise<any> | (() => Promise<any>),
    options?: {log?: boolean}
  ): Promise<null | {
    from: string;
    to?: string;
    value?: string;
    data?: string;
  }> {
    const outputLog = !options || options.log === undefined || options.log;
    try {
      if (action instanceof Promise) {
        await action;
      } else {
        await action();
      }
    } catch (e) {
      if (e instanceof UnknownSignerError) {
        const {from, to, data, value, contract} = e.data;
        if (outputLog) {
          console.log(
            `---------------------------------------------------------------------------------------`
          );
          console.error('no signer for ' + from);
          console.log(`Please execute the following:`);
          console.log(
            `---------------------------------------------------------------------------------------`
          );
          if (contract) {
            console.log(
              `
from: ${from}
to: ${to} (${contract.name})${
                value
                  ? '\nvalue: ' +
                    (typeof value === 'string' ? value : value.toString())
                  : ''
              }
method: ${contract.method}
args:
  - ${contract.args.join('\n  - ')}

(raw data: ${data} )
`
            );
          } else {
            console.log(
              `
from: ${from}
to: ${to ? to : '0x0000000000000000000000000000000000000000'}${
                value
                  ? '\nvalue: ' +
                    (typeof value === 'string' ? value : value.toString())
                  : ''
              }
data: ${data}
`
            );
          }
          console.log(
            `---------------------------------------------------------------------------------------`
          );
        }
        if (!value || typeof value === 'string') {
          return {from, to, value, data};
        }
        return {from, to, value: value?.toString(), data};
      } else {
        throw e;
      }
    }
    return null;
  }

  async function execute(
    name: string,
    options: TxOptions,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt> {
    options = {...options}; // ensure no change
    await init();
    const {
      address: from,
      ethersSigner,
      hardwareWallet,
      unknown,
    } = getFrom(options.from);

    let tx;
    const deployment = await partialExtension.get(name);
    const abi = deployment.abi;
    const overrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      maxFeePerGas: options.maxFeePerGas
        ? BigNumber.from(options.maxFeePerGas)
        : undefined,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas
        ? BigNumber.from(options.maxPriorityFeePerGas)
        : undefined,
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce,
    };

    const ethersContract = new Contract(deployment.address, abi, ethersSigner);
    if (!ethersContract.functions[methodName]) {
      throw new Error(
        `No method named "${methodName}" on contract deployed as "${name}"`
      );
    }

    const numArguments =
      ethersContract.interface.getFunction(methodName).inputs.length;
    if (args.length !== numArguments) {
      throw new Error(
        `expected ${numArguments} arguments for method "${methodName}", got ${args.length}`
      );
    }

    await overrideGasLimit(overrides, options, (newOverrides) => {
      const ethersArgsWithGasLimit = args
        ? args.concat([newOverrides])
        : [newOverrides];
      return ethersContract.estimateGas[methodName](...ethersArgsWithGasLimit);
    });
    await setupGasPrice(overrides);
    await setupNonce(from, overrides);
    const ethersArgs = args ? args.concat([overrides]) : [overrides];

    if (unknown) {
      const ethersArgs = args ? args.concat([overrides]) : [overrides];
      const {data} = await ethersContract.populateTransaction[methodName](
        ...ethersArgs
      );
      throw new UnknownSignerError({
        from,
        to: deployment.address,
        data,
        value: options.value,
        contract: {
          name,
          method: methodName,
          args,
        },
      });
    }

    if (options.log || hardwareWallet) {
      print(`executing ${name}.${methodName}`);
      if (hardwareWallet) {
        print(` (please confirm on your ${hardwareWallet})`);
      }
    }

    tx = await handleSpecificErrors(
      ethersContract.functions[methodName](...ethersArgs)
    );

    tx = await onPendingTx(tx);

    if (options.log || hardwareWallet) {
      print(` (tx: ${tx.hash}) ...`);
    }

    if (options.autoMine) {
      try {
        await provider.send('evm_mine', []);
      } catch (e) {}
    }
    const receipt = await tx.wait();
    if (options.log || hardwareWallet) {
      print(`: performed with ${receipt.gasUsed} gas\n`);
    }
    return receipt;
  }

  // TODO ?
  // async function rawCall(to: string, data: string) {
  //   // TODO call it eth_call?
  //   await init();
  //   return provider.send("eth_call", [
  //     {
  //       to,
  //       data
  //     },
  //     "latest"
  //   ]); // TODO overrides
  // }

  async function read(
    name: string,
    options: CallOptions | string,
    methodName?: string | any,
    ...args: unknown[]
  ) {
    if (typeof options === 'string') {
      if (typeof methodName !== 'undefined') {
        args.unshift(methodName);
      }
      methodName = options;
      options = {};
    }
    options = {...options}; // ensure no change
    await init();
    if (typeof args === 'undefined') {
      args = [];
    }
    let caller: Web3Provider | Signer = provider;
    const {ethersSigner} = getOptionalFrom(options.from);
    if (ethersSigner) {
      caller = ethersSigner;
    }
    const deployment = await partialExtension.get(name);
    if (!deployment) {
      throw new Error(`no contract named "${name}"`);
    }
    const abi = deployment.abi;
    const overrides: PayableOverrides = {
      gasLimit: options.gasLimit,
      gasPrice: options.gasPrice ? BigNumber.from(options.gasPrice) : undefined, // TODO cinfig
      maxFeePerGas: options.maxFeePerGas
        ? BigNumber.from(options.maxFeePerGas)
        : undefined,
      maxPriorityFeePerGas: options.maxPriorityFeePerGas
        ? BigNumber.from(options.maxPriorityFeePerGas)
        : undefined,
      value: options.value ? BigNumber.from(options.value) : undefined,
      nonce: options.nonce,
    };
    const ethersContract = new Contract(
      deployment.address,
      abi,
      caller as Signer
    );
    // populate function
    // if (options.outputTx) {
    //   const method = ethersContract.populateTransaction[methodName];
    //   if (!method) {
    //     throw new Error(
    //       `no method named "${methodName}" on contract "${name}"`
    //     );
    //   }
    //   if (args.length > 0) {
    //     return method(...args, overrides);
    //   } else {
    //     return method(overrides);
    //   }
    // }
    const method = ethersContract.callStatic[methodName];
    if (!method) {
      throw new Error(`no method named "${methodName}" on contract "${name}"`);
    }
    if (args.length > 0) {
      return method(...args, overrides);
    } else {
      return method(overrides);
    }
  }

  const extension: DeploymentsExtension = {
    ...partialExtension,
    fetchIfDifferent,
    deploy,
    diamond: {
      deploy: diamond,
    },
    catchUnknownSigner,
    execute,
    rawTx,
    read,
    deterministic,
  };

  const utils = {
    dealWithPendingTransactions: async (
      pendingTxs: {
        [txHash: string]: {
          name: string;
          deployment?: any;
          rawTx: string;
          decoded: {
            from: string;
            gasPrice?: string;
            maxFeePerGas?: string | BigNumber;
            maxPriorityFeePerGas?: string | BigNumber;
            gasLimit: string;
            to: string;
            value: string;
            nonce: number;
            data: string;
            r: string;
            s: string;
            v: number;
            // creates: tx.creates, // TODO test
            chainId: number;
          };
        };
      },
      pendingTxPath: string,
      globalGasPrice: string | undefined
    ) => {
      await init();
      const txHashes = Object.keys(pendingTxs);
      for (const txHash of txHashes) {
        let tx: Transaction | undefined;
        const txData = pendingTxs[txHash];
        if (txData.rawTx || txData.decoded) {
          if (txData.rawTx) {
            tx = parseTransaction(txData.rawTx);
          } else {
            tx = recode(txData.decoded);
          }
          // alternative add options to deploy task to delete pending tx, combined with --gasprice this would work (except for timing edge case)
        } else {
          console.error(`no access to raw data for tx ${txHash}`);
        }

        const txFromPeers = await network.provider.send(
          'eth_getTransactionByHash',
          [txHash]
        );

        let feeHistory:
          | {
              baseFeePerGas: string[];
              gasUsedRatio?: number[]; // not documented on https://playground.open-rpc.org/?schemaUrl=https://raw.githubusercontent.com/ethereum/eth1.0-apis/assembled-spec/openrpc.json&uiSchema%5BappBar%5D%5Bui:splitView%5D=false&uiSchema%5BappBar%5D%5Bui:input%5D=false&uiSchema%5BappBar%5D%5Bui:examplesDropdown%5D=false
              oldestBlock: number;
              reward: string[][];
            }
          | undefined = undefined;
        let newGasPriceS = globalGasPrice;
        if (!newGasPriceS) {
          newGasPriceS = await network.provider.send('eth_gasPrice', []);
          try {
            feeHistory = await network.provider.send('eth_feeHistory', [
              4,
              'latest',
              [25, 75],
            ]);
          } catch (e) {}
        }
        const newGasPrice = BigNumber.from(newGasPriceS);

        let newBaseFee: BigNumber | undefined = undefined;
        if (feeHistory) {
          newBaseFee = BigNumber.from(
            feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]
          );
        }

        const choices = ['skip (forget tx)'];
        if (!txFromPeers) {
          if (tx) {
            choices.unshift('broadcast again');
          }
          console.log(`transaction ${txHash} cannot be found among peers`);
        } else {
          choices.unshift('continue waiting');
          if (tx) {
            console.log(
              `transaction ${txHash} still pending... It used a gas pricing config of ${
                tx.gasPrice
                  ? `(gasPrice: ${tx.gasPrice.toString()} wei)`
                  : tx.maxPriorityFeePerGas || tx.maxPriorityFeePerGas
                  ? `maxPriorityFeePerGas: ${tx.maxPriorityFeePerGas?.toString()} maxFeePerGas: ${tx.maxFeePerGas?.toString()}`
                  : ``
              } ,
              current gas price is ${newGasPrice.toString()} wei
              ${newBaseFee ? `new baseFee is ${newBaseFee.toString()}` : ''}
              `
            );
          } else {
            console.log(`transaction ${txHash} still pending...`);
          }
        }

        if (tx && tx.gasPrice && tx.gasPrice.lt(newGasPrice)) {
          choices.unshift('increase gas');
        } else if (tx && (tx.maxFeePerGas || tx.maxPriorityFeePerGas)) {
          // choices.unshift(); // TODO
          // console.log('TODO handle EIP1559 gas pricing increase');
          choices.unshift('increase gas');
        }

        const prompt = new (enquirer as any).Select({
          name: 'action',
          message: 'Choose what to do with the pending transaction:',
          choices,
        });

        const answer = await prompt.run();
        let txHashToWait: string | undefined;
        if (answer !== 'skip (forget tx)') {
          if (answer === 'continue waiting') {
            console.log('waiting for transaction...');
            txHashToWait = txHash;
          } else if (answer === 'broadcast again') {
            if (!tx) {
              throw new Error(`cannot resubmit a tx if info not available`);
            }

            if (txData.rawTx) {
              const tx = await handleSpecificErrors(
                provider.sendTransaction(txData.rawTx)
              );
              txHashToWait = tx.hash;
              if (tx.hash !== txHash) {
                console.error('non mathcing tx hashes after resubmitting...');
              }
              console.log('waiting for newly broadcasted tx ...');
            } else {
              console.log('resigning the tx...');
              const {ethersSigner, hardwareWallet} = getOptionalFrom(tx.from);
              if (!ethersSigner) {
                throw new Error('no signer for ' + tx.from);
              }

              if (hardwareWallet) {
                print(` (please confirm on your ${hardwareWallet})`);
              }

              const txReq = await handleSpecificErrors(
                ethersSigner.sendTransaction({
                  to: tx.to,
                  from: tx.from,
                  nonce: tx.nonce,

                  gasLimit: tx.gasLimit,
                  gasPrice: tx.gasPrice,
                  maxFeePerGas: tx.maxFeePerGas,
                  maxPriorityFeePerGas: tx.maxPriorityFeePerGas,

                  data: tx.data,
                  value: tx.value,
                  chainId: tx.chainId,
                  type: tx.type === null ? undefined : tx.type,
                  accessList: tx.accessList,
                })
              );
              txHashToWait = txReq.hash;
              if (txReq.hash !== txHash) {
                delete pendingTxs[txHash];
                if (Object.keys(pendingTxs).length === 0) {
                  fs.removeSync(pendingTxPath);
                } else {
                  fs.writeFileSync(
                    pendingTxPath,
                    JSON.stringify(pendingTxs, null, '  ')
                  );
                }
                await onPendingTx(txReq);
                console.error('non mathcing tx hashes after resubmitting...');
              }
            }
          } else if (answer === 'increase gas') {
            if (!tx) {
              throw new Error(`cannot resubmit a tx if info not available`);
            }
            const {ethersSigner, hardwareWallet} = getOptionalFrom(tx.from);
            if (!ethersSigner) {
              throw new Error('no signer for ' + tx.from);
            }

            if (hardwareWallet) {
              print(` (please confirm on your ${hardwareWallet})`);
            }

            const gasPriceSetup = await getGasPrice();
            const maxFeePerGas = gasPriceSetup.maxFeePerGas;
            const maxPriorityFeePerGas = gasPriceSetup.maxPriorityFeePerGas;
            let gasPrice: BigNumber | undefined;
            if (!maxFeePerGas && !maxPriorityFeePerGas) {
              gasPrice = gasPriceSetup.gasPrice;
              if (gasPrice) {
                console.log('using legacy gasPrice with gasprice passed in');
              }
            }
            // if (!gasPrice && !maxFeePerGas && !maxPriorityFeePerGas) {
            //   console.log('using legacy gasPrice, TODO handle auto pricing')
            //   gasPrice = newGasPrice;
            // }

            const txReq = await handleSpecificErrors(
              ethersSigner.sendTransaction({
                to: tx.to,
                from: tx.from,
                nonce: tx.nonce,

                gasLimit: tx.gasLimit,
                gasPrice,
                maxFeePerGas,
                maxPriorityFeePerGas,

                data: tx.data,
                value: tx.value,
                chainId: tx.chainId,
                type: tx.type === null ? undefined : tx.type,
                accessList: tx.accessList,
              })
            );
            txHashToWait = txReq.hash;
            delete pendingTxs[txHash];
            if (Object.keys(pendingTxs).length === 0) {
              fs.removeSync(pendingTxPath);
            } else {
              fs.writeFileSync(
                pendingTxPath,
                JSON.stringify(pendingTxs, null, '  ')
              );
            }
            await onPendingTx(txReq);
            console.log(`new transaction submitted, waiting... ${txReq.hash}`);
          }
        }

        if (txHashToWait) {
          const receipt = await waitForTx(
            network.provider,
            txHashToWait,
            false
          );
          if (
            (!receipt.status || receipt.status == 1) && // ensure we do not save failed deployment
            receipt.contractAddress &&
            txData.name
          ) {
            await saveDeployment(txData.name, {
              ...txData.deployment,
              receipt,
            });
          }
        }

        delete pendingTxs[txHash];
        if (Object.keys(pendingTxs).length === 0) {
          fs.removeSync(pendingTxPath);
        } else {
          fs.writeFileSync(
            pendingTxPath,
            JSON.stringify(pendingTxs, null, '  ')
          );
        }
      }
    },
  };

  // ////////// Backward compatible for transition: //////////////////
  (extension as any).call = (
    options: any,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<any> => {
    if (typeof options === 'string') {
      args = args || [];
      if (methodName !== undefined) {
        args.unshift(methodName);
      }
      methodName = name;
      name = options;
      options = {};
    }
    return read(name, options, methodName, ...args);
  };

  (extension as any).sendTxAndWait = (
    options: TxOptions,
    name: string,
    methodName: string,
    ...args: any[]
  ): Promise<Receipt | null> => {
    return execute(name, options, methodName, ...args);
  };

  (extension as any).deployIfDifferent = (
    name: string,
    options: DeployOptions,
    contractName: string,
    ...args: any[]
  ): Promise<DeployResult> => {
    options.contract = contractName;
    options.args = args;
    return deploy(name, options);
  };
  // ////////////////////////////////////////////////////////////////////

  return {extension, utils};
}

function pause(duration: number): Promise<void> {
  return new Promise((res) => setTimeout(res, duration * 1000));
}

export async function waitForTx(
  ethereum: EthereumProvider,
  txHash: string,
  isContract: boolean
): Promise<Receipt> {
  let receipt;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      receipt = await ethereum.send('eth_getTransactionReceipt', [txHash]);
    } catch (e) {}
    if (receipt && receipt.blockNumber) {
      if (isContract) {
        if (!receipt.contractAddress) {
          throw new Error('contract not deployed');
        } else {
          return receipt;
        }
      } else {
        return receipt;
      }
    }
    await pause(2);
  }
}
