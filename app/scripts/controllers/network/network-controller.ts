import { strict as assert } from 'assert';
import EventEmitter from 'events';
import { ComposedStore, ObservableStore } from '@metamask/obs-store';
import log from 'loglevel';
import {
  createSwappableProxy,
  createEventEmitterProxy,
} from '@metamask/swappable-obj-proxy';
import type { SwappableProxy } from '@metamask/swappable-obj-proxy';
import EthQuery from 'eth-query';
import { v4 as uuid } from 'uuid';
import type { PollingBlockTracker } from 'eth-block-tracker';
import type { SafeEventEmitterProvider } from '@metamask/eth-json-rpc-provider';
import { add0x } from '@metamask/utils';
import type { Hex } from '@metamask/utils';
import {
  INFURA_PROVIDER_TYPES,
  INFURA_BLOCKED_KEY,
  TEST_NETWORK_TICKER_MAP,
  CHAIN_IDS,
  NETWORK_TYPES,
  BUILT_IN_INFURA_NETWORKS,
} from '../../../../shared/constants/network';
import type { BuiltInInfuraNetwork } from '../../../../shared/constants/network';
import getFetchWithTimeout from '../../../../shared/modules/fetch-with-timeout';
import {
  isPrefixedFormattedHexString,
  isSafeChainId,
} from '../../../../shared/modules/network.utils';
import {
  MetaMetricsEventCategory,
  MetaMetricsEventPayload,
} from '../../../../shared/constants/metametrics';
import { isErrorWithMessage } from '../../../../shared/modules/error';
import {
  createNetworkClient,
  NetworkClientType,
} from './create-network-client';

/**
 * Encodes both whether or not a provider is configured for an Infura network or
 * a non-Infura network; if for an Infura network, then which network; and if
 * for a non-Infura network, then whether the network is being operated locally
 * or remotely. Primarily used to build the network client and check the
 * availability of a network.
 */
type ProviderType = BuiltInInfuraNetwork | typeof NETWORK_TYPES.RPC;

/**
 * The network ID of a network.
 */
type NetworkId = string;

/**
 * The ID of a network configuration.
 */
type NetworkConfigurationId = string;

/**
 * The chain ID of a network.
 */
type ChainId = Hex;

/**
 * Information used to set up the middleware stack for a particular kind of
 * network.
 */
type ProviderConfiguration = {
  /**
   * Holds either a type of Infura network, or "localhost" for a locally
   * operated network, or "rpc" for everything else.
   */
  type: ProviderType;
  /**
   * The chain ID as per EIP-155.
   */
  chainId: ChainId;
  /**
   * The URL of the RPC endpoint. Only used when `type` is "localhost" or "rpc".
   */
  rpcUrl?: string;
  /**
   * The shortname of the currency used by the network.
   */
  ticker?: string;
  /**
   * The user-customizable name of the network.
   */
  nickname?: string;
  /**
   * User-customizable details for the network.
   */
  rpcPrefs?: {
    blockExplorerUrl?: string;
  };
  /**
   * The ID of the network configuration associated with this provider
   * configuration.
   */
  id?: NetworkConfigurationId;
};

/**
 * Coalesces two disparate pieces of data. If a network is available, then it
 * holds the network ID of the network; otherwise it holds "loading".
 */
type NetworkState = NetworkId | 'loading';

/**
 * Information about the network not held by any other part of state. Currently
 * only used to capture whether a network supports EIP-1559.
 */
type NetworkDetails = {
  /**
   * Holds which EIPs are supported by the network.
   */
  EIPS: {
    [eipNumber: number]: boolean | undefined;
  };
};

/**
 * Information used to set up the middleware stack for a particular kind of
 * network.
 */
type NetworkConfiguration = {
  /**
   * The unique ID of the network configuration. Useful for removing.
   */
  id: NetworkConfigurationId;
  /**
   * The URL of the RPC endpoint. Only used when `type` is "localhost" or "rpc".
   */
  rpcUrl: string;
  /**
   * The chain ID as per EIP-155.
   */
  chainId: ChainId;
  /**
   * The shortname of the currency used for this network.
   */
  ticker: string;
  /**
   * The user-customizable name of the network.
   */
  nickname?: string;
  /**
   * User-customizable details for the network.
   */
  rpcPrefs?: {
    blockExplorerUrl: string;
  };
};

/**
 * A set of network configurations, keyed by ID.
 */
type NetworkConfigurations = Record<
  NetworkConfigurationId,
  NetworkConfiguration
>;

/**
 * The state that NetworkController holds after combining its individual stores.
 */
type CompositeState = {
  provider: ProviderConfiguration;
  previousProviderStore: ProviderConfiguration;
  network: NetworkState;
  networkDetails: NetworkDetails;
  networkConfigurations: NetworkConfigurations;
};

/**
 * The options that NetworkController takes.
 */
type NetworkControllerOptions = {
  state?: {
    provider?: ProviderConfiguration;
    networkDetails?: NetworkDetails;
    networkConfigurations?: NetworkConfigurations;
  };
  infuraProjectId: string;
  trackMetaMetricsEvent: (payload: MetaMetricsEventPayload) => void;
};

/**
 * A block header object that `eth_getBlockByNumber` returns. Note that this
 * type does not specify all of the properties of the kind of object that this
 * RPC method usually returns. We are only interested in the `baseFeePerGas`.
 */
type Block = {
  baseFeePerGas?: unknown;
};

/**
 * An object that either represents a successful result of an asynchronous
 * operation or an unsuccessful result.
 *
 * @template Value - The type of the value, if the result was successful.
 */
type Result<Value> = { value: Value } | { error: unknown };

/**
 * A function that makes an HTTP request, timing out after the specified
 * duration.
 */
const fetchWithTimeout = getFetchWithTimeout();

/**
 * The default provider config used to initialize the NetworkController.
 */
let defaultProviderConfig: ProviderConfiguration;
if (process.env.IN_TEST) {
  defaultProviderConfig = {
    type: NETWORK_TYPES.RPC,
    rpcUrl: 'http://localhost:8545',
    chainId: add0x('0x539'),
    nickname: 'Localhost 8545',
    ticker: 'ETH',
  };
} else if (process.env.METAMASK_DEBUG || process.env.METAMASK_ENV === 'test') {
  defaultProviderConfig = {
    type: NETWORK_TYPES.GOERLI,
    chainId: CHAIN_IDS.GOERLI,
    ticker: TEST_NETWORK_TICKER_MAP[NETWORK_TYPES.GOERLI],
  };
} else {
  defaultProviderConfig = {
    type: NETWORK_TYPES.MAINNET,
    chainId: CHAIN_IDS.MAINNET,
    ticker: 'ETH',
  };
}

/**
 * The default network details state used to initialize the NetworkController.
 */
const defaultNetworkDetailsState: NetworkDetails = {
  EIPS: {
    1559: undefined,
  },
};

/**
 * Events that the NetworkController fires at various junctions.
 */
export const NETWORK_EVENTS = {
  /**
   * Fired after the actively selected network is changed.
   */
  NETWORK_DID_CHANGE: 'networkDidChange',
  /**
   * Fired when the actively selected network *will* change.
   */
  NETWORK_WILL_CHANGE: 'networkWillChange',
  /**
   * Fired when Infura returns an error indicating no support.
   */
  INFURA_IS_BLOCKED: 'infuraIsBlocked',
  /**
   * Fired when not using an Infura network or when Infura returns no error,
   * indicating support.
   */
  INFURA_IS_UNBLOCKED: 'infuraIsUnblocked',
};

/**
 * Returns whether the given argument is a type that our Infura middleware
 * recognizes. We can't calculate this inline because the usual type of `type`,
 * which we get from the provider config, is not a subset of the type of
 * `INFURA_PROVIDER_TYPES`, but rather a superset, and therefore we cannot make
 * a proper comparison without TypeScript complaining. However, if we downcast
 * both variables, then we are able to achieve this. As a bonus, this function
 * also types the given argument as a `BuiltInInfuraNetwork` assuming that the
 * check succeeds.
 *
 * @param type - A type to compare.
 * @returns True or false, depending on whether the given type is one that our
 * Infura middleware recognizes.
 */
function isInfuraProviderType(type: string): type is BuiltInInfuraNetwork {
  const infuraProviderTypes: readonly string[] = INFURA_PROVIDER_TYPES;
  return infuraProviderTypes.includes(type);
}

export class NetworkController extends EventEmitter {
  /**
   * Holds the provider configuration.
   */
  providerStore: ObservableStore<ProviderConfiguration>;

  /**
   * Holds the provider configuration for the previously configured network.
   */
  previousProviderStore: ObservableStore<ProviderConfiguration>;

  /**
   * Holds the network ID for the current network or "loading" if there is no
   * current network.
   */
  networkStore: ObservableStore<NetworkState>;

  /**
   * Holds details about the network.
   */
  networkDetails: ObservableStore<NetworkDetails>;

  /**
   * Holds network configurations.
   */
  networkConfigurationsStore: ObservableStore<NetworkConfigurations>;

  /**
   * Holds a combination of data from all of the stores.
   */
  store: ComposedStore<CompositeState>;

  _provider: SafeEventEmitterProvider | null;

  _blockTracker: PollingBlockTracker | null;

  _providerProxy: SwappableProxy<SafeEventEmitterProvider> | null;

  _blockTrackerProxy: SwappableProxy<PollingBlockTracker> | null;

  _infuraProjectId: NetworkControllerOptions['infuraProjectId'];

  _trackMetaMetricsEvent: NetworkControllerOptions['trackMetaMetricsEvent'];

  /**
   * Constructs a network controller.
   *
   * @param options - The options.
   * @param options.state - Initial controller state.
   * @param options.infuraProjectId - The Infura project ID.
   * @param options.trackMetaMetricsEvent - A method to forward events to the
   * {@link MetaMetricsController}.
   */
  constructor({
    state = {},
    infuraProjectId,
    trackMetaMetricsEvent,
  }: NetworkControllerOptions) {
    super();

    // create stores
    this.providerStore = new ObservableStore(
      state.provider || { ...defaultProviderConfig },
    );
    this.previousProviderStore = new ObservableStore(
      this.providerStore.getState(),
    );
    this.networkStore = new ObservableStore('loading');
    // We need to keep track of a few details about the current network
    // Ideally we'd merge this.networkStore with this new store, but doing so
    // will require a decent sized refactor of how we're accessing network
    // state. Currently this is only used for detecting EIP 1559 support but
    // can be extended to track other network details.
    this.networkDetails = new ObservableStore(
      state.networkDetails || {
        ...defaultNetworkDetailsState,
      },
    );

    this.networkConfigurationsStore = new ObservableStore(
      state.networkConfigurations || {},
    );

    this.store = new ComposedStore({
      provider: this.providerStore,
      previousProviderStore: this.previousProviderStore,
      network: this.networkStore,
      networkDetails: this.networkDetails,
      networkConfigurations: this.networkConfigurationsStore,
    });

    // provider and block tracker
    this._provider = null;
    this._blockTracker = null;

    // provider and block tracker proxies - because the network changes
    this._providerProxy = null;
    this._blockTrackerProxy = null;

    if (!infuraProjectId || typeof infuraProjectId !== 'string') {
      throw new Error('Invalid Infura project ID');
    }
    this._infuraProjectId = infuraProjectId;
    this._trackMetaMetricsEvent = trackMetaMetricsEvent;

    this.on(NETWORK_EVENTS.NETWORK_DID_CHANGE, () => {
      this.lookupNetwork();
    });
  }

  /**
   * Deactivates the controller, stopping any ongoing polling.
   *
   * In-progress requests will not be aborted.
   */
  async destroy() {
    await this._blockTracker?.destroy();
  }

  /**
   * Creates the provider and block tracker for the network that was specified
   * in state when the controller was initialized.
   */
  async initializeProvider() {
    const { type, rpcUrl, chainId } = this.providerStore.getState();
    this._configureProvider({ type, rpcUrl, chainId });
    await this.lookupNetwork();
  }

  /**
   * Returns the proxies wrapping the currently set provider and block tracker.
   */
  getProviderAndBlockTracker() {
    const provider = this._providerProxy;
    const blockTracker = this._blockTrackerProxy;
    return { provider, blockTracker };
  }

  /**
   * Checks the latest block on the network, storing whether or not the network
   * supports EIP-1559 depending on whether the block has a `baseFeePerGas`
   * property.
   *
   * @returns Whether or not the network supports EIP-1559.
   */
  async getEIP1559Compatibility() {
    const { EIPS } = this.networkDetails.getState();
    // NOTE: This isn't necessary anymore because the block cache middleware
    // already prevents duplicate requests from taking place
    if (EIPS[1559] !== undefined) {
      return EIPS[1559];
    }
    const { provider } = this.getProviderAndBlockTracker();

    if (!provider) {
      // Really we should throw an error if a provider hasn't been initialized
      // yet, but that might have undesirable repercussions, so return false for
      // now
      return false;
    }

    const latestBlock = await this._getLatestBlock(provider);
    const supportsEIP1559 = latestBlock?.baseFeePerGas !== undefined;
    this._setNetworkEIPSupport(1559, supportsEIP1559);
    return supportsEIP1559;
  }

  /**
   * Performs side effects after switching to a network. If the network is
   * available, updates the network state with the network ID of the network and
   * stores whether the network supports EIP-1559; otherwise clears said
   * information about the network that may have been previously stored.
   *
   * @fires infuraIsBlocked if the network is Infura-supported and is blocking
   * requests.
   * @fires infuraIsUnblocked if the network is Infura-supported and is not
   * blocking requests, or if the network is not Infura-supported.
   */
  async lookupNetwork() {
    const { provider } = this.getProviderAndBlockTracker();

    // Prevent firing when provider is not defined.
    if (!provider) {
      log.warn(
        'NetworkController - lookupNetwork aborted due to missing provider',
      );
      return;
    }

    const { chainId } = this.providerStore.getState();
    if (!chainId) {
      log.warn(
        'NetworkController - lookupNetwork aborted due to missing chainId',
      );
      this._setNetworkState('loading');
      this._clearNetworkDetails();
      return;
    }

    // Ping the RPC endpoint so we can confirm that it works
    const initialNetwork = this.networkStore.getState();
    const { type } = this.providerStore.getState();
    const isInfura = isInfuraProviderType(type);

    if (isInfura) {
      this._checkInfuraAvailability(type);
    } else {
      this.emit(NETWORK_EVENTS.INFURA_IS_UNBLOCKED);
    }

    let networkVersionResult: Result<string>;
    try {
      networkVersionResult = {
        value: await this._getNetworkId(provider),
      };
    } catch (error) {
      networkVersionResult = {
        error,
      };
    }
    if (initialNetwork !== this.networkStore.getState()) {
      return;
    }

    if ('error' in networkVersionResult) {
      this._setNetworkState('loading');
      // keep network details in sync with network state
      this._clearNetworkDetails();
    } else {
      this._setNetworkState(networkVersionResult.value);
      // look up EIP-1559 support
      await this.getEIP1559Compatibility();
    }
  }

  /**
   * Switches to the network specified by a network configuration.
   *
   * @param networkConfigurationId - The unique identifier that refers to a
   * previously added network configuration.
   * @returns The URL of the RPC endpoint representing the newly switched
   * network.
   */
  setActiveNetwork(networkConfigurationId: NetworkConfigurationId) {
    const targetNetwork =
      this.networkConfigurationsStore.getState()[networkConfigurationId];

    if (!targetNetwork) {
      throw new Error(
        `networkConfigurationId ${networkConfigurationId} does not match a configured networkConfiguration`,
      );
    }

    this._setProviderConfig({
      type: NETWORK_TYPES.RPC,
      ...targetNetwork,
    });

    return targetNetwork.rpcUrl;
  }

  /**
   * Switches to an Infura-supported network.
   *
   * @param type - The shortname of the network.
   * @throws if the `type` is "rpc" or if it is not a known Infura-supported
   * network.
   */
  setProviderType(type: string) {
    assert.notStrictEqual(
      type,
      NETWORK_TYPES.RPC,
      `NetworkController - cannot call "setProviderType" with type "${NETWORK_TYPES.RPC}". Use "setActiveNetwork"`,
    );
    assert.ok(
      isInfuraProviderType(type),
      `Unknown Infura provider type "${type}".`,
    );
    const network = BUILT_IN_INFURA_NETWORKS[type];
    this._setProviderConfig({
      type,
      rpcUrl: '',
      chainId: network.chainId,
      ticker: 'ticker' in network ? network.ticker : 'ETH',
      nickname: '',
      rpcPrefs: { blockExplorerUrl: network.blockExplorerUrl },
    });
  }

  /**
   * Re-initializes the provider and block tracker for the current network.
   */
  resetConnection() {
    this._setProviderConfig(this.providerStore.getState());
  }

  /**
   * Switches to the previous network, assuming that the current network is
   * different than the initial network (if it is, then this is equivalent to
   * calling `resetConnection`).
   */
  rollbackToPreviousProvider() {
    const config = this.previousProviderStore.getState();
    this.providerStore.putState(config);
    this._switchNetwork(config);
  }

  //
  // Private
  //

  /**
   * Fetches the network ID for the network.
   *
   * @param provider - A provider, which is guaranteed to be available.
   * @returns A promise that either resolves to the network ID, or rejects with
   * an error.
   */
  async _getNetworkId(provider: SafeEventEmitterProvider): Promise<string> {
    const ethQuery = new EthQuery(provider);
    return await new Promise((resolve, reject) => {
      ethQuery.sendAsync<never[], string>(
        { method: 'net_version' },
        (...args) => {
          if (args[0] === null) {
            resolve(args[1]);
          } else {
            reject(args[0]);
          }
        },
      );
    });
  }

  /**
   * Fetches the latest block for the network.
   *
   * @param provider - A provider, which is guaranteed to be available.
   * @returns A promise that either resolves to the block header or null if
   * there is no latest block, or rejects with an error.
   */
  _getLatestBlock(provider: SafeEventEmitterProvider): Promise<Block | null> {
    return new Promise((resolve, reject) => {
      const ethQuery = new EthQuery(provider);
      ethQuery.sendAsync<['latest', false], Block | null>(
        { method: 'eth_getBlockByNumber', params: ['latest', false] },
        (...args) => {
          if (args[0] === null) {
            resolve(args[1]);
          } else {
            reject(args[0]);
          }
        },
      );
    });
  }

  /**
   * Updates the network store.
   *
   * @param network - The new network state.
   */
  _setNetworkState(network: NetworkState): void {
    this.networkStore.putState(network);
  }

  /**
   * Stores whether or not the network supports a particular EIP.
   *
   * @param EIPNumber - The number of the EIP to mark support for.
   * @param isSupported - Whether the EIP is supported.
   */
  _setNetworkEIPSupport(EIPNumber: number, isSupported: boolean): void {
    this.networkDetails.putState({
      EIPS: {
        [EIPNumber]: isSupported,
      },
    });
  }

  /**
   * Clears details for the network, including support for EIPs.
   */
  _clearNetworkDetails() {
    this.networkDetails.putState({ ...defaultNetworkDetailsState });
  }

  /**
   * Stores the given provider configuration representing a network in state,
   * then uses it to create a new provider for that network.
   *
   * @param config - The provider configuration.
   */
  _setProviderConfig(config: ProviderConfiguration) {
    this.previousProviderStore.putState(this.providerStore.getState());
    this.providerStore.putState(config);
    this._switchNetwork(config);
  }

  /**
   * Checks whether the current Infura-supported network is available or not by
   * making an arbitrary request and checking the response.
   *
   * @param network - The shortname of the Infura-supported network.
   * @fires infuraIsBlocked if Infura is blocking requests, i.e. if the request
   * contains a `countryBlocked` error.
   * @fires infuraIsUnblocked if Infura is not blocking requests.
   */
  async _checkInfuraAvailability(network: BuiltInInfuraNetwork) {
    const rpcUrl = `https://${network}.infura.io/v3/${this._infuraProjectId}`;

    let networkChanged = false;
    this.once(NETWORK_EVENTS.NETWORK_DID_CHANGE, () => {
      networkChanged = true;
    });

    try {
      const response = await fetchWithTimeout(rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
      });

      if (networkChanged) {
        return;
      }

      if (response.ok) {
        this.emit(NETWORK_EVENTS.INFURA_IS_UNBLOCKED);
      } else {
        const responseMessage = await response.json();
        if (networkChanged) {
          return;
        }
        if (responseMessage.error === INFURA_BLOCKED_KEY) {
          this.emit(NETWORK_EVENTS.INFURA_IS_BLOCKED);
        }
      }
    } catch (err) {
      log.warn(`MetaMask - Infura availability check failed`, err);
    }
  }

  /**
   * Executes a series of steps to change the current network:
   *
   * 1. Notifies subscribers that the network is about to change.
   * 2. Clears state associated with the current network.
   * 3. Creates a new network client along with a provider for the desired
   * network.
   * 4. Notifies subscribes that the network has changed.
   *
   * @param config - The provider configuration object that specifies the new
   * network.
   */
  _switchNetwork(config: ProviderConfiguration) {
    // Indicate to subscribers that network is about to change
    this.emit(NETWORK_EVENTS.NETWORK_WILL_CHANGE);
    // Set loading state
    this._setNetworkState('loading');
    // Reset network details
    this._clearNetworkDetails();
    // Configure the provider appropriately
    this._configureProvider(config);
    // Notify subscribers that network has changed
    this.emit(NETWORK_EVENTS.NETWORK_DID_CHANGE, config.type);
  }

  /**
   * Creates a network client (a stack of middleware along with a provider and
   * block tracker) to talk to a network.
   *
   * @param args - The arguments.
   * @param args.type - The shortname of an Infura-supported network (see
   * {@link NETWORK_TYPES}).
   * @param args.rpcUrl - The URL of the RPC endpoint that represents the
   * network. Only used for non-Infura networks.
   * @param args.chainId - The chain ID of the network (as per EIP-155). Only
   * used for non-Infura-supported networks (as we already know the chain ID of
   * any Infura-supported network).
   * @throws if the `type` if not a known Infura-supported network.
   */
  _configureProvider({ type, rpcUrl, chainId }: ProviderConfiguration) {
    const isInfura = isInfuraProviderType(type);
    if (isInfura) {
      // infura type-based endpoints
      this._configureInfuraProvider({
        type,
        infuraProjectId: this._infuraProjectId,
      });
    } else if (type === NETWORK_TYPES.RPC && rpcUrl) {
      // url-based rpc endpoints
      this._configureStandardProvider(rpcUrl, chainId);
    } else {
      throw new Error(
        `NetworkController - _configureProvider - unknown type "${type}"`,
      );
    }
  }

  /**
   * Creates a network client (a stack of middleware along with a provider and
   * block tracker) to talk to an Infura-supported network.
   *
   * @param args - The arguments.
   * @param args.type - The shortname of the Infura network (see
   * {@link NETWORK_TYPES}).
   * @param args.infuraProjectId - An Infura API key. ("Project ID" is a
   * now-obsolete term we've retained for backward compatibility.)
   */
  _configureInfuraProvider({
    type,
    infuraProjectId,
  }: {
    type: BuiltInInfuraNetwork;
    infuraProjectId: NetworkControllerOptions['infuraProjectId'];
  }) {
    log.info('NetworkController - configureInfuraProvider', type);
    const { provider, blockTracker } = createNetworkClient({
      network: type,
      infuraProjectId,
      type: NetworkClientType.Infura,
    });
    this._setProviderAndBlockTracker({ provider, blockTracker });
  }

  /**
   * Creates a network client (a stack of middleware along with a provider and
   * block tracker) to talk to a non-Infura-supported network.
   *
   * @param rpcUrl - The URL of the RPC endpoint that represents the network.
   * @param chainId - The chain ID of the network (as per EIP-155).
   */
  _configureStandardProvider(rpcUrl: string, chainId: ChainId) {
    log.info('NetworkController - configureStandardProvider', rpcUrl);
    const { provider, blockTracker } = createNetworkClient({
      chainId,
      rpcUrl,
      type: NetworkClientType.Custom,
    });
    this._setProviderAndBlockTracker({ provider, blockTracker });
  }

  /**
   * Given a provider and a block tracker, updates any proxies pointing to
   * these objects that have been previously set, or initializes any proxies
   * that have not been previously set.
   *
   * @param args - The arguments.
   * @param args.provider - The provider.
   * @param args.blockTracker - The block tracker.
   */
  _setProviderAndBlockTracker({
    provider,
    blockTracker,
  }: {
    provider: SafeEventEmitterProvider;
    blockTracker: PollingBlockTracker;
  }) {
    // update or initialize proxies
    if (this._providerProxy) {
      this._providerProxy.setTarget(provider);
    } else {
      this._providerProxy = createSwappableProxy(provider);
    }
    if (this._blockTrackerProxy) {
      this._blockTrackerProxy.setTarget(blockTracker);
    } else {
      this._blockTrackerProxy = createEventEmitterProxy(blockTracker, {
        eventFilter: 'skipInternal',
      });
    }
    // set new provider and blockTracker
    this._provider = provider;
    this._blockTracker = blockTracker;
  }

  /**
   * Network Configuration management functions
   */

  /**
   * Updates an existing network configuration matching the same RPC URL as the
   * given network configuration; otherwise adds the network configuration.
   * Following the upsert, the `trackMetaMetricsEvent` callback specified
   * via the NetworkController constructor will be called to (presumably) create
   * a MetaMetrics event.
   *
   * @param networkConfiguration - The network configuration to upsert.
   * @param networkConfiguration.chainId - The chain ID of the network as per
   * EIP-155.
   * @param networkConfiguration.ticker - The shortname of the currency used by
   * the network.
   * @param networkConfiguration.nickname - The user-customizable name of the
   * network.
   * @param networkConfiguration.rpcPrefs - User-customizable details for the
   * network.
   * @param networkConfiguration.rpcUrl - The URL of the RPC endpoint.
   * @param additionalArgs - Additional arguments.
   * @param additionalArgs.setActive - Switches to the network specified by
   * the given network configuration following the upsert.
   * @param additionalArgs.referrer - The site from which the call originated,
   * or 'metamask' for internal calls; used for event metrics.
   * @param additionalArgs.source - Where the metric event originated (i.e. from
   * a dapp or from the network form); used for event metrics.
   * @throws if the `chainID` does not match EIP-155 or is too large.
   * @throws if `rpcUrl` is not a valid URL.
   * @returns The ID for the added or updated network configuration.
   */
  upsertNetworkConfiguration(
    {
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    }: Omit<NetworkConfiguration, 'id'>,
    {
      setActive = false,
      referrer,
      source,
    }: {
      setActive: boolean;
      referrer: string;
      source: string;
    },
  ) {
    assert.ok(
      isPrefixedFormattedHexString(chainId),
      `Invalid chain ID "${chainId}": invalid hex string.`,
    );
    assert.ok(
      isSafeChainId(parseInt(chainId, 16)),
      `Invalid chain ID "${chainId}": numerical value greater than max safe value.`,
    );

    if (!rpcUrl) {
      throw new Error(
        'An rpcUrl is required to add or update network configuration',
      );
    }

    if (!referrer || !source) {
      throw new Error(
        'referrer and source are required arguments for adding or updating a network configuration',
      );
    }

    try {
      // eslint-disable-next-line no-new
      new URL(rpcUrl);
    } catch (e) {
      if (isErrorWithMessage(e) && e.message.includes('Invalid URL')) {
        throw new Error('rpcUrl must be a valid URL');
      }
    }

    if (!ticker) {
      throw new Error(
        'A ticker is required to add or update networkConfiguration',
      );
    }

    const networkConfigurations = this.networkConfigurationsStore.getState();
    const newNetworkConfiguration = {
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    };

    const oldNetworkConfigurationId = Object.values(networkConfigurations).find(
      (networkConfiguration) =>
        networkConfiguration.rpcUrl?.toLowerCase() === rpcUrl?.toLowerCase(),
    )?.id;

    const newNetworkConfigurationId = oldNetworkConfigurationId || uuid();
    this.networkConfigurationsStore.putState({
      ...networkConfigurations,
      [newNetworkConfigurationId]: {
        ...newNetworkConfiguration,
        id: newNetworkConfigurationId,
      },
    });

    if (!oldNetworkConfigurationId) {
      this._trackMetaMetricsEvent({
        event: 'Custom Network Added',
        category: MetaMetricsEventCategory.Network,
        referrer: {
          url: referrer,
        },
        properties: {
          chain_id: chainId,
          symbol: ticker,
          source,
        },
      });
    }

    if (setActive) {
      this.setActiveNetwork(newNetworkConfigurationId);
    }

    return newNetworkConfigurationId;
  }

  /**
   * Removes a network configuration from state.
   *
   * @param networkConfigurationId - The unique id for the network configuration
   * to remove.
   */
  removeNetworkConfiguration(networkConfigurationId: NetworkConfigurationId) {
    const networkConfigurations = {
      ...this.networkConfigurationsStore.getState(),
    };
    delete networkConfigurations[networkConfigurationId];
    this.networkConfigurationsStore.putState(networkConfigurations);
  }
}
