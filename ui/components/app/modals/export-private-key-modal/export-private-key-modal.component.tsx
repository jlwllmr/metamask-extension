import log from 'loglevel';
import React, { ReactNode, useContext, useEffect, useState } from 'react';

import copyToClipboard from 'copy-to-clipboard';
import Box from '../../../ui/box';
import {
  BUTTON_SIZES,
  BUTTON_TYPES,
  Button,
  Text,
} from '../../../component-library';
import AccountModalContainer from '../account-modal-container';
import {
  toChecksumHexAddress,
  stripHexPrefix,
} from '../../../../../shared/modules/hexstring-utils';
import {
  EVENT,
  EVENT_NAMES,
} from '../../../../../shared/constants/metametrics';
import HoldToRevealModal from '../hold-to-reveal-modal/hold-to-reveal-modal';
import { MetaMetricsContext } from '../../../../contexts/metametrics';
import { useI18nContext } from '../../../../hooks/useI18nContext';
import {
  AlignItems,
  BLOCK_SIZES,
  BackgroundColor,
  BorderColor,
  BorderRadius,
  BorderStyle,
  Color,
  DISPLAY,
  FLEX_DIRECTION,
  FONT_WEIGHT,
  JustifyContent,
  Size,
  TEXT_ALIGN,
  TextColor,
  TextVariant,
} from '../../../../helpers/constants/design-system';

interface ExportPrivateKeyModalProps {
  exportAccount: (password: string, address: string) => Promise<string>;
  selectedIdentity: {
    name: string;
    address: string;
  };
  warning?: ReactNode;
  showAccountDetailModal: () => void;
  hideModal: () => void;
  hideWarning: () => void;
  clearAccountDetails: () => void;
  previousModalState?: string;
}

const ExportPrivateKeyModal = ({
  clearAccountDetails,
  hideWarning,
  exportAccount,
  selectedIdentity,
  showAccountDetailModal,
  hideModal,
  warning = null,
  previousModalState,
}: ExportPrivateKeyModalProps) => {
  const [password, setPassword] = useState<string>('');
  const [privateKey, setPrivateKey] = useState<string | undefined>(undefined);
  const [showWarning, setShowWarning] = useState<boolean>(true);
  const [showHoldToReveal, setShowHoldToReveal] = useState<boolean>(false);

  const trackEvent = useContext(MetaMetricsContext);
  const t = useI18nContext();

  useEffect(() => {
    return () => {
      clearAccountDetails();
      hideWarning();
    };
  }, []);

  const exportAccountAndGetPrivateKey = (
    passwordInput: string,
    address: string,
  ): void => {
    exportAccount(passwordInput, address)
      .then((privateKeyRetrieved: string) => {
        trackEvent(
          {
            category: EVENT.CATEGORIES.KEYS,
            event: EVENT_NAMES.KEY_EXPORT_REVEALED,
            properties: {
              key_type: EVENT.KEY_TYPES.PKEY,
            },
          },
          {},
        );
        setPrivateKey(privateKeyRetrieved);
        setShowWarning(false);
        setShowHoldToReveal(true);
      })
      .catch((e) => {
        trackEvent(
          {
            category: EVENT.CATEGORIES.KEYS,
            event: EVENT_NAMES.KEY_EXPORT_FAILED,
            properties: {
              key_type: EVENT.KEY_TYPES.PKEY,
              reason: 'incorrect_password',
            },
          },
          {},
        );

        log.error(e);
      });
  };

  const renderPasswordLabel = (privateKeyInput: string) => {
    return (
      <Text
        as="span"
        color={Color.textDefault}
        marginBottom={2}
        variant={TextVariant.bodySm}
      >
        {privateKeyInput ? t('copyPrivateKey') : t('typePassword')}
      </Text>
    );
  };

  const renderPasswordInput = (privateKeyInput: string): ReactNode => {
    const plainKey = privateKeyInput && stripHexPrefix(privateKeyInput);

    if (!privateKeyInput) {
      return (
        <input
          aria-label="input-password"
          type="password"
          className="export-private-key-modal__password-input"
          onChange={(event) => setPassword(event.target.value)}
        />
      );
    }

    return (
      <Box
        className="export-private-key-modal__private-key-display"
        borderStyle={BorderStyle.solid}
        borderColor={BorderColor.borderDefault}
        borderRadius={BorderRadius.XS}
        borderWidth={1}
        padding={[2, 3, 2]}
        color={Color.errorDefault}
        onClick={() => {
          copyToClipboard(plainKey);
          trackEvent(
            {
              category: EVENT.CATEGORIES.KEYS,
              event: EVENT_NAMES.KEY_EXPORT_COPIED,
              properties: {
                key_type: EVENT.KEY_TYPES.PKEY,
                copy_method: 'clipboard',
              },
            },
            {},
          );
        }}
      >
        {plainKey}
      </Box>
    );
  };

  const renderButtons = (
    privateKeyInput: string,
    address: string,
    // eslint-disable-next-line @typescript-eslint/no-shadow
    hideModal: () => void,
  ): ReactNode => {
    return (
      <Box
        display={DISPLAY.FLEX}
        flexDirection={FLEX_DIRECTION.ROW}
        width={BLOCK_SIZES.FULL}
        justifyContent={JustifyContent.spaceBetween}
        padding={[0, 5]}
      >
        {!privateKeyInput && (
          <Button
            type={BUTTON_TYPES.SECONDARY}
            size={BUTTON_SIZES.LG}
            width={BLOCK_SIZES.HALF}
            marginRight={4}
            onClick={() => {
              trackEvent(
                {
                  category: EVENT.CATEGORIES.KEYS,
                  event: EVENT_NAMES.KEY_EXPORT_CANCELED,
                  properties: {
                    key_type: EVENT.KEY_TYPES.PKEY,
                  },
                },
                {},
              );
              hideModal();
            }}
          >
            {t('cancel')}
          </Button>
        )}
        {privateKey ? (
          <Button
            type={BUTTON_TYPES.PRIMARY}
            size={BUTTON_SIZES.LG}
            width={BLOCK_SIZES.FULL}
            onClick={() => {
              hideModal();
            }}
          >
            {t('done')}
          </Button>
        ) : (
          <Button
            type={BUTTON_TYPES.PRIMARY}
            size={BUTTON_SIZES.LG}
            width={BLOCK_SIZES.HALF}
            onClick={() => {
              trackEvent(
                {
                  category: EVENT.CATEGORIES.KEYS,
                  event: EVENT_NAMES.KEY_EXPORT_REQUESTED,
                  properties: {
                    key_type: EVENT.KEY_TYPES.PKEY,
                  },
                },
                {},
              );

              exportAccountAndGetPrivateKey(password, address);
            }}
            disabled={!password}
          >
            {t('confirm')}
          </Button>
        )}
      </Box>
    );
  };

  const { name, address } = selectedIdentity;

  return (
    <AccountModalContainer
      className="export-private-key-modal"
      selectedIdentity={selectedIdentity}
      showBackButton={previousModalState === 'ACCOUNT_DETAILS'}
      backButtonAction={() => showAccountDetailModal()}
    >
      {showHoldToReveal ? (
        <HoldToRevealModal
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          onLongPressed={(): void => setShowHoldToReveal(false)}
          willHide={false}
        />
      ) : (
        <>
          <Text
            as="span"
            marginTop={2}
            variant={TextVariant.bodyLgMedium}
            fontWeight={FONT_WEIGHT.NORMAL}
          >
            {name}
          </Text>
          <Box
            className="ellip-address-wrapper"
            borderStyle={BorderStyle.solid}
            borderColor={BorderColor.borderDefault}
            borderWidth={1}
            marginTop={2}
            padding={[1, 2, 1, 2]}
          >
            {toChecksumHexAddress(address)}
          </Box>
          <Box
            className="export-private-key-modal__divider"
            width={BLOCK_SIZES.FULL}
            margin={[5, 0, 3, 0]}
            // backgroundColor={BackgroundColor.}
          />
          <Text
            variant={TextVariant.bodyLgMedium}
            margin={[4, 0, 4, 0]}
            fontWeight={FONT_WEIGHT.NORMAL}
          >
            {t('showPrivateKeys')}
          </Text>
          <Box
            flexDirection={FLEX_DIRECTION.COLUMN}
            alignItems={AlignItems.flexStart}
          >
            {renderPasswordLabel(privateKey as string)}
            {renderPasswordInput(privateKey as string)}
            {showWarning ? (
              <Text color={Color.errorDefault} variant={TextVariant.bodySm}>
                {warning}
              </Text>
            ) : null}
          </Box>
          <Box
            borderRadius={BorderRadius.MD}
            borderWidth={1}
            backgroundColor={BackgroundColor.errorMuted}
            borderColor={BorderColor.errorDefault}
            padding={[1, 3, 0, 3]}
            marginLeft={5}
            marginRight={5}
            marginTop={4}
          >
            <Text
              color={TextColor.textDefault}
              fontWeight={FONT_WEIGHT.MEDIUM}
              variant={TextVariant.bodyXs}
            >
              {t('privateKeyWarning')}
            </Text>
          </Box>
          {renderButtons(privateKey as string, address, hideModal)}
        </>
      )}
    </AccountModalContainer>
  );
};

export default ExportPrivateKeyModal;