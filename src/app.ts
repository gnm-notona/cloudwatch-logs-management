
import { CloudWatchLogs, S3, Lambda } from 'aws-sdk';

import { getCommonConfig, getSetRetentionConfig, getConfigureLogShippingConfig } from './config';
import { getCloudWatchLogGroups, setCloudwatchRetention, subscribeGroups, unsubscribeGroups } from "./cloudwatch";
import { updateStructuredFieldsData } from './structuredFields';

const { region } = getCommonConfig();

const cloudwatchLogs = new CloudWatchLogs({ region, maxRetries: 10 });
const s3 = new S3({ region });
const lambda = new Lambda({ region });

function sleep(ms: number){
    return new Promise(resolve=>{
        setTimeout(resolve, ms)
    })
}

export async function setRetention(): Promise<void> {
    const { retentionInDays } = getSetRetentionConfig();

    const cloudwatchLogGroups = await getCloudWatchLogGroups(cloudwatchLogs);
    for(const logGroup of cloudwatchLogGroups) {
        if (logGroup.retentionInDays === retentionInDays) {
            console.log(`Log group ${logGroup.logGroupName} retention is already ${retentionInDays} days`);
        } else {
            await setCloudwatchRetention(cloudwatchLogs, logGroup.logGroupName!, retentionInDays);
            // avoid hitting the SDK throttling limit
            await sleep(200);
            console.log(`Set ${logGroup.logGroupName} retention to ${retentionInDays} days`);
        }
    }
}

function eligibleForLogShipping(logNamePrefixes: string[], groupName: string, excludeName: string): boolean {
    const matchesPrefix = logNamePrefixes.length == 0 || logNamePrefixes.some(prefix => groupName.startsWith(prefix));
    const isExcluded = groupName === excludeName;
    return matchesPrefix && !isExcluded;
}

export async function setLogShipping(trigger: any): Promise<void> {
    console.log('Configuring log shipping');
    console.log(JSON.stringify(trigger));
    const { logNamePrefixes, logShippingFilterName, logShippingLambdaArn,
         structuredDataBucket, structuredDataKey, optionLowerFirstCharOfTags } = getConfigureLogShippingConfig();

    await updateStructuredFieldsData(s3, lambda, structuredDataBucket, structuredDataKey, optionLowerFirstCharOfTags);

    const logShippingLambdaName = logShippingLambdaArn.split(':')[6];
    
    // get list of log groups
    const allGroups = await getCloudWatchLogGroups(cloudwatchLogs);
    
    // subscribe those groups that should have shipping enabled
    const logShippingLambdaLogGroupName = `/aws/lambda/${logShippingLambdaName}`;
    console.log(`Excluding ${logShippingLambdaLogGroupName} from eligible log groups`);
    const logShippingGroups = allGroups.filter((group) => {
        return eligibleForLogShipping(logNamePrefixes, group.logGroupName!, logShippingLambdaLogGroupName);
    });
    console.log(`${logShippingGroups.length} groups eligible for log shipping: ${logShippingGroups.map(group => group.logGroupName!).join(', ')}`);
    await subscribeGroups(cloudwatchLogs, logShippingGroups, logShippingFilterName, logShippingLambdaArn)

    const removeShippingGroups = allGroups.filter((group) => {
        return !eligibleForLogShipping(logNamePrefixes, group.logGroupName!, logShippingLambdaLogGroupName);
    });
    await unsubscribeGroups(cloudwatchLogs, removeShippingGroups, logShippingFilterName);
}
