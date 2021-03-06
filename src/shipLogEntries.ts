import zlib from 'zlib';

import { CloudWatchLogsEvent, CloudWatchLogsDecodedData, CloudWatchLogsLogEvent, Context } from "aws-lambda";
import { Kinesis, S3, ChainableTemporaryCredentials } from 'aws-sdk';

import { getCommonConfig, getShipLogsConfig } from './config';
import { putKinesisRecords } from './kinesis';
import { getStructuredFields } from './structuredFields';

const { region } = getCommonConfig();
const { kinesisStreamName, kinesisStreamRole, structuredDataBucket, structuredDataKey } = getShipLogsConfig();

const s3 = new S3({ region });
const kinesis = getKinesisClient(region, kinesisStreamRole);

function getKinesisClient(region: string, role: string | undefined): Kinesis {
    if (!!role) {
        const credentials = new ChainableTemporaryCredentials({
            params: {
                RoleArn: role,
                RoleSessionName: `shipLogEntries-lambda`
             }
        })
        return new Kinesis({ region, maxRetries: 10, credentials });
    } else {
        return new Kinesis({ region, maxRetries: 10 });
    }
}

function isRequestLogEntry(line: string): boolean {
    return line.startsWith('START RequestId: ') ||
           line.startsWith('END RequestId: ') ||
           line.startsWith('REPORT RequestId: ') 
}

function fieldValue(text: string, fieldNameText: string, valueLength?: number): string {
    return text.substr(text.indexOf(fieldNameText)+fieldNameText.length, valueLength).trim();
}

/**
 * Parse an AWS lambda report field into a field name and a value
 * @param rawField The raw field that looks something like "Field Name: value unit"
 */
function parseReportField(rawField: string): [string, any] {
    const [rawFieldName, rawFieldValue] = rawField.split(':').map(s => s.trim());

    const fieldNameNoSpaces = rawFieldName.replace(/ /g, '');
    const fieldName = fieldNameNoSpaces.charAt(0).toLowerCase() + fieldNameNoSpaces.slice(1);

    const [value, unit] = rawFieldValue.split(' ');

    if (unit == 'ms' || unit == 'MB') {
        // value should be numeric
        const numericValue = parseFloat(value);
        return [fieldName + unit, numericValue] as [string, any];
    } else {
        // we didn't recognise the unit, perhaps there isn't one
        return [fieldName, rawFieldValue] as [string, any];
    }
}

function lambdaRequestLogData(line: string): StructuredLogData | undefined {
    if (isRequestLogEntry(line)) {
        const eventName = line.substr(0, line.indexOf(' '));
        const requestId = fieldValue(line, 'RequestId:', 36);
        const base = {
            lambdaEvent: eventName,
            lambdaRequestId: requestId
        };
        let stats: StructuredLogData = {};
        switch(eventName) {
            case 'END':
                // no other fields
                break;
            case 'START':
                // extract Version:
                const version = fieldValue(line, 'Version:');
                stats = {
                    lambdaVersion: version
                };
                break;
            case 'REPORT':
                // extract other fields (conveniently tab separated)
                const rawFields = line.split('\t').slice(1).map(s => s.trim()).filter(s => s.length > 0);
                const fields: [string, any][] = rawFields.map(rawField => parseReportField(rawField));
                stats = fields.reduce((acc: StructuredLogData, field) => {
                    const [fieldName, fieldValue] = field;
                    acc[fieldName] = fieldValue;
                    return acc;
                }, {});
                break;
        }

        return Object.assign(base, {
            lambdaStats: stats
        });
    } else {
        return undefined;
    }
}

function parseMessageJson(line: string): StructuredLogData {
    try {
        return JSON.parse(line.trim());
    } catch (err) {
        return {
            'message': line.trim(),
        };
    }
}

// this parses a log line of the format <date>\t<requestId>\t<level>\t<message>
function parseNodeLogFormat(logGroup: string, line: String): StructuredLogData | undefined {
    const elements = line.split('\t');
    const [dateString, lambdaRequestId, level, ...messageParts] = elements;
    const isDate = !isNaN(Date.parse(dateString));
    if (elements.length >= 4 && isDate) {
        const message = messageParts.join('\t')
        const structuredLog = parseMessageJson(message);
        return {
            ...structuredLog,
            //timestamp: dateString, // this makes it explode for some reason
            lambdaRequestId,
            level,
        }
    }
}

// parse a log line
function parseLambdaLogLine(logGroup: string, line: string): StructuredLogData {
    const lambdaRequestLogDataFields = lambdaRequestLogData(line);
    if (!!lambdaRequestLogDataFields) {
        return Object.assign(lambdaRequestLogDataFields, {
            'message': line,
        });
    } 
    // next see if this is the log line type we get from 
    const nodeLogData = parseNodeLogFormat(logGroup, line)
    if (!!nodeLogData) {
        return nodeLogData;
    }
    // fall back to normal parsing
    return parseMessageJson(line);
}

function createStructuredLog(logGroup: string, logEvent: CloudWatchLogsLogEvent, extraFields: StructuredFields): PublishableStructuredLogData {
    const structuredLog = parseLambdaLogLine(logGroup, logEvent.message.trim());
    const publishable: PublishableStructuredLogData = 
        Object.assign(structuredLog, {
            '@timestamp': structuredLog.timestamp || new Date(logEvent.timestamp).toISOString(),
            cloudwatchId: logEvent.id,
            cloudwatchLogGroup: logGroup,
        });
    return Object.keys(extraFields)
        .reduce((acc: PublishableStructuredLogData, key) => {
            if (!!acc[key]) {
                acc[`overwrittenFields.${key}`] = acc[key];
            }
            acc[key] = extraFields[key];
            return acc;
        }, publishable);
}

export async function shipLogEntries(event: CloudWatchLogsEvent, context: Context): Promise<void> {
    const payload = new Buffer(event.awslogs.data, 'base64');
    const json = zlib.gunzipSync(payload).toString('utf8');
    const decoded: CloudWatchLogsDecodedData = JSON.parse(json);

    console.log('decoded CloudWatch logs to forward', decoded);

    const logGroup = decoded.logGroup;
    const extraFields: StructuredFields = 
        await getStructuredFields(s3, logGroup, structuredDataBucket, structuredDataKey).catch((reason) => {
            console.log(`Unable to get structured fields for ${logGroup} due to ${reason} - falling back to no extra fields`)
            return {};
        });
    const structuredLogs = decoded.logEvents.map((logEvent) => {
        const log = createStructuredLog(logGroup, logEvent, extraFields);
        return log;
    });
    console.log(`Sending ${structuredLogs.length} events from ${logGroup} to ${kinesisStreamName} (with role: ${kinesisStreamRole})`);
    
    await putKinesisRecords(kinesis, kinesisStreamName, structuredLogs);
}