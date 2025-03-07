import { InfoCircleOutlined } from '@ant-design/icons';
import { PencilIcon } from '@heroicons/react/solid';
import { AdjustmentsIcon } from '@heroicons/react/outline';
import { Alert, Icon, SearchField, AlertIcon, Tooltip, Popover, Grid, GridItem, Text, Box, redpandaTheme, ChakraProvider, redpandaToastOptions } from '@redpanda-data/ui';
import { Input, message, Modal, Radio, Select } from 'antd';
import { Observer, observer, useLocalObservable } from 'mobx-react';
import { FC } from 'react';
import { ConfigEntryExtended } from '../../../state/restInterfaces';
import { formatConfigValue } from '../../../utils/formatters/ConfigValueFormatter';
import { DataSizeSelect, DurationSelect, NumInput, RatioInput } from './CreateTopicModal/CreateTopicModal';
import './TopicConfiguration.scss';
import { ModalFunc } from 'antd/lib/modal/confirm';
import { api } from '../../../state/backendApi';
import Password from 'antd/lib/input/Password';
import { isServerless } from '../../../config';


type ConfigurationEditorProps = {
    targetTopic: string | null, // topic name, or null if default configs
    entries: ConfigEntryExtended[],
    onForceRefresh: () => void,
}

const ConfigurationEditor: FC<ConfigurationEditorProps> = observer((props) => {
    const $state = useLocalObservable<{
        isEditing: boolean;
        filter?: string;
        modalValueType: 'default' | 'custom';
        modalError: string | null,
        modal: ReturnType<ModalFunc> | null;
    }>(() => ({
        isEditing: false,
        modalValueType: 'default',
        modalError: null,
        modal: null,
    }))

    const editConfig = (configEntry: ConfigEntryExtended) => {
        if ($state.modal) {
            $state.modal.destroy();
        }

        configEntry.currentValue = configEntry.value;

        const defaultEntry = configEntry.synonyms?.last();
        const defaultValue = defaultEntry?.value ?? configEntry.value;
        const defaultSource = defaultEntry?.source ?? configEntry.source;
        const friendlyDefault = formatConfigValue(configEntry.name, defaultValue, 'friendly');
        const initialValueType = configEntry.isExplicitlySet ? 'custom' : 'default';
        $state.modalValueType = initialValueType;
        $state.modalError = null;

        $state.modal = Modal.confirm({
            title: <><Icon as={AdjustmentsIcon}/> {'Edit ' + configEntry.name}</>,
            width: '80%',
            style: {minWidth: '400px', maxWidth: '600px', top: '50px'},
            bodyStyle: {paddingTop: '1em'},
            className: 'configModal',

            okText: 'Save changes',

            closable: false,
            keyboard: false,
            maskClosable: false,
            icon: null,

            content: <Observer>{() => {
                const isCustom = $state.modalValueType == 'custom';

                return (
                    <ChakraProvider
                        theme={redpandaTheme}
                        toastOptions={redpandaToastOptions}
                        disableGlobalStyle={true}
                        disableEnvironment={true}
                    >
                        <div>
                            <p>Edit <code>{configEntry.name}</code> configuration for topic <code>{props.targetTopic}</code>.</p>
                            <div style={{
                                padding: '1em',
                                background: 'rgb(238, 238, 238)',
                                color: 'hsl(0deg 0% 50%)',
                                borderRadius: '8px',
                                margin: '1em 0'
                            }}>{configEntry.documentation}</div>

                            <div style={{fontWeight: 'bold', marginBottom: '0.5em'}}>Value</div>
                            <Radio.Group className="valueRadioGroup" value={$state.modalValueType} onChange={e => $state.modalValueType = e.target.value}>
                                <Radio value="default">
                                    <span>Default: </span>
                                    <span style={{fontWeight: 'bold'}}>{friendlyDefault}</span>
                                    <div className="subText">Inherited from {defaultSource}</div>
                                </Radio>
                                <Radio value="custom">
                                    <span>Custom</span>
                                    <div className="subText">Set at topic configuration</div>
                                    <div style={{position: 'relative', zIndex: 2}} onClick={e => {
                                        if (isCustom) {
                                            // If the editor is *already* active, we don't want to propagate clicks out to the radio buttons
                                            // otherwise they will steal focus, closing any select/dropdowns
                                            e.stopPropagation();
                                            e.preventDefault();
                                        }
                                    }}>
                                        <ConfigEntryEditor className={'configEntryEditor ' + (isCustom ? '' : 'disabled')} entry={configEntry}/>
                                    </div>
                                </Radio>
                            </Radio.Group>

                            {$state.modalError && <Alert status="error" style={{margin: '1em 0'}}>
                                <AlertIcon/>
                                {$state.modalError}
                            </Alert>}
                        </div>
                    </ChakraProvider>
                )
            }}</Observer>,
            onOk: async () => {

                // When do we need to apply?
                // -> When the "type" changed (from default to custom or vice-versa)
                // -> When type is "custom" and "currentValue" changed
                // So this excludes the case where value was changed, but the type was "default" before and after
                let needToApply = false;
                if ($state.modalValueType != initialValueType)
                    needToApply = true;
                if ($state.modalValueType == 'custom' && configEntry.value != configEntry.currentValue)
                    needToApply = true;

                if (!needToApply)
                    return;

                const operation = $state.modalValueType == 'custom'
                    ? 'SET'
                    : 'DELETE';

                try {
                    await api.changeTopicConfig(props.targetTopic, [
                        {
                            key: configEntry.name,
                            op: operation,
                            value: (operation == 'SET')
                                ? String(configEntry.currentValue)
                                : undefined,
                        }
                    ]);
                    // TODO - do after modals migration
                    message.success(<>Successfully updated config <code>{configEntry.name}</code></>)
                    // toast({
                    //     status: 'success',
                    //     description: <span>Successfully updated config <code>{configEntry.name}</code></span>,
                    // })
                } catch (err) {
                    console.error('error while applying config change', {err, configEntry});
                    $state.modalError = (err instanceof Error)
                        ? err.message
                        : String(err);
                    // we must to throw an error to keep the modal open
                    throw err;
                }

                props.onForceRefresh()
            },
        });
    }

    const topic = props.targetTopic;
    const hasEditPermissions = topic
        ? api.topicPermissions.get(topic)?.canEditTopicConfig ?? true
        : true;

    let entries = props.entries;
    const filter = $state.filter;
    if (filter)
        entries = entries.filter(x => x.name.includes(filter) || (x.value ?? '').includes(filter));

    const entryOrder = {
        'retention': -3,
        'cleanup': -2,
    };

    entries = entries.slice().sort((a, b) => {
        for (const [e, order] of Object.entries(entryOrder)) {
            if (a.name.includes(e) && !b.name.includes(e)) return order;
            if (b.name.includes(e) && !a.name.includes(e)) return -order;
        }
        return 0;
    });

    const categories = entries.groupInto(x => x.category);
    for (const e of categories) if (!e.key) e.key = 'Other';

    return (
        <Box pt={4}>
            <div className="configGroupTable">
                <SearchField searchText={$state.filter || ''} placeholderText="Filter" setSearchText={value => ($state.filter = value)} icon="filter"/>
                {categories.map(x => (
                    <ConfigGroup key={x.key} groupName={x.key} entries={x.items} onEditEntry={editConfig} hasEditPermissions={hasEditPermissions}/>
                ))}
            </div>
        </Box>
    );
})

export default ConfigurationEditor


const ConfigGroup = observer((p: { groupName?: string; onEditEntry: (configEntry: ConfigEntryExtended) => void; entries: ConfigEntryExtended[]; hasEditPermissions: boolean }) => {
    return (
        <>
            <div className="configGroupSpacer"/>
            {p.groupName && <div className="configGroupTitle">{p.groupName}</div>}
            {p.entries.map(e => (
                <ConfigEntry key={e.name} entry={e} onEditEntry={p.onEditEntry} hasEditPermissions={p.hasEditPermissions}/>
            ))}
        </>
    );
});

const ConfigEntry = observer((p: { onEditEntry: (configEntry: ConfigEntryExtended) => void; entry: ConfigEntryExtended; hasEditPermissions: boolean }) => {
    const {canEdit, reason: nonEdittableReason} = isTopicConfigEdittable(p.entry, p.hasEditPermissions);

    const entry = p.entry;
    const friendlyValue = formatConfigValue(entry.name, entry.value, 'friendly');

    return (
        <>
            <span className="configName">{p.entry.name}</span>

            <span className="configValue">{friendlyValue}</span>

            <span className="isEditted">{entry.isExplicitlySet && 'Custom'}</span>

            <span className="spacer"></span>

            <span className="configButtons">
                <Tooltip label={nonEdittableReason} placement="left" isDisabled={canEdit} hasArrow>
                    <span
                        className={'btnEdit' + (canEdit ? '' : ' disabled')}
                        onClick={() => {
                            if (canEdit) p.onEditEntry(p.entry);
                        }}
                    >
                        <Icon as={PencilIcon}/>
                    </span>
                </Tooltip>
                {entry.documentation && (
                    <Popover
                        hideCloseButton
                        size="lg"
                        content={
                            <Grid templateColumns="1fr" gap={4} w="fit-content">
                                <GridItem>
                                    <strong>{entry.name}</strong>
                                    <br/>
                                    {entry.documentation}
                                </GridItem>
                                <GridItem>
                                    <Grid templateColumns="25% 1fr" gap={2}>
                                        <GridItem>
                                            <strong>Value</strong>
                                        </GridItem>
                                        <GridItem>
                                            <span>{friendlyValue}</span>
                                        </GridItem>
                                        <GridItem>
                                            <strong>Source</strong>
                                        </GridItem>
                                        <GridItem>
                                            <div>
                                                <code>{entry.source}</code>
                                            </div>
                                            <Text fontSize="sm">{getConfigSourceExplanation(entry.source)}</Text>
                                        </GridItem>
                                    </Grid>
                                </GridItem>
                            </Grid>
                        }
                    >
                        <Icon as={InfoCircleOutlined}/>
                    </Popover>
                )}
            </span>
        </>
    );
});

function isTopicConfigEdittable(entry: ConfigEntryExtended, hasEditPermissions: boolean): { canEdit: boolean; reason?: string } {
    if (!hasEditPermissions) return {canEdit: false, reason: 'You don\'t have permissions to change topic configuration entries'};

    if (isServerless()) {
        const edittableEntries = ['retention.ms', 'retention.bytes'];

        if (edittableEntries.includes(entry.name)) {
            return {canEdit: true};
        }

        return {canEdit: false, reason: 'This configuration is not editable on Serverless clusters'};
    }

    return {canEdit: true};
}


export const ConfigEntryEditor = observer((p: {
    entry: ConfigEntryExtended;
    className?: string;
}) => {
    const entry = p.entry;
    switch (entry.frontendFormat) {
        case 'BOOLEAN':
            return <Select value={entry.currentValue} onChange={c => entry.currentValue = c} className={p.className}
                           options={[
                               {value: 'false', label: 'False'},
                               {value: 'true', label: 'True'},
                           ]}
            />

        case 'SELECT':
            return <Select value={entry.currentValue} onChange={e => entry.currentValue = e} className={p.className}>
                {(entry.enumValues ?? []).map(v => <Select.Option key={v}>
                    {v}
                </Select.Option>)}
            </Select>
        case 'MULTI_SELECT':
            return <Select value={entry.currentValue} onChange={e => entry.currentValue = e} mode="multiple" className={p.className}>
                {(entry.enumValues ?? []).map(v => <Select.Option key={v}>
                    {v}
                </Select.Option>)}
            </Select>

        case 'BYTE_SIZE':
            return <DataSizeSelect
                allowInfinite={true}
                valueBytes={Number(entry.currentValue ?? 0)}
                onChange={e => entry.currentValue = Math.round(e)}
                className={p.className}
            />
        case 'DURATION':
            return <DurationSelect
                allowInfinite={true}
                valueMilliseconds={Number(entry.currentValue ?? 0)}
                onChange={e => entry.currentValue = Math.round(e)}
                className={p.className}
            />

        case 'PASSWORD':
            return <Password value={entry.currentValue ?? ''} onChange={x => entry.currentValue = x.target.value}/>

        case 'RATIO':
            return <RatioInput value={Number(entry.currentValue)} onChange={x => entry.currentValue = x}/>

        case 'INTEGER':
            return <NumInput value={Number(entry.currentValue)} onChange={e => entry.currentValue = Math.round(e ?? 0)} className={p.className}/>

        case 'DECIMAL':
            return <NumInput value={Number(entry.currentValue)} onChange={e => entry.currentValue = e} className={p.className}/>

        case 'STRING':
        default:
            return <Input value={String(entry.currentValue)} onChange={e => entry.currentValue = e.target.value} className={p.className}/>
    }
});

function getConfigSourceExplanation(source: string) {
    switch (source) {
        case 'DEFAULT_CONFIG':
            return 'Built-in default when the setting is not overriden anywhere';

        case 'DYNAMIC_BROKER_CONFIG':
        case 'DYNAMIC_BROKER_LOGGER_CONFIG':
        case 'DYNAMIC_DEFAULT_BROKER_CONFIG':
            return 'Set at broker level';

        case 'DYNAMIC_TOPIC_CONFIG':
            return 'Set for this specific topic';

        case 'STATIC_BROKER_CONFIG':
            return 'Set on the broker by either a config file or environment variable';

        default:
            return '';
    }
}
