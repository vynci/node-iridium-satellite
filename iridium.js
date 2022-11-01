const uuid = require('uuid');
const events = require('events');

const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');

const config = require('./config');

const port = new SerialPort(config.serialPath, { baudRate: config.baudRate });
const parser = port.pipe(new Readline());

const sbd = new events.EventEmitter();
const atCommandQueueEvent = new events.EventEmitter();
const sendMessageQueueEvent = new events.EventEmitter();

let atCommandQueue = [];
let sendMessageQueue = [];
let currentSBDIXAttempts = 0;

let currentSerialJob = {};

const shiftSendMessageQueue = async (queueId, status, data) => {
    sendMessageQueue.shift();
    sendMessageQueueEvent.emit(queueId, {status, data});

    if(sendMessageQueue.length) await consumeSendMessageQueue();
}

const shiftATCommandQueue = (queueId, status, data) => {
    atCommandQueue.shift();
    atCommandQueueEvent.emit(queueId, {status, data});

    if(atCommandQueue.length) consumeATCommandQueue();
}

const consumeATCommandQueue = () => {
    const queue = atCommandQueue[0];

    console.log('running AT task: ', atCommandQueue[0].id);

    const queueTimeout = setTimeout(()=> {
        shiftATCommandQueue(queue.id, 'reject', 'timeout');
    }, 10000);

    port.write(queue.cmd, (err) => {
        if (err) shiftATCommandQueue(queue.id, 'reject', err);
        setCurrentSerialJob(queue.id, queue.delimiter, queue.usePrependDelimeter);
        clearTimeout(queueTimeout);
    });
}

const consumeSendMessageQueue = async () => {
    const queue = sendMessageQueue[0];

    console.log('sending message: ', queue.id);

    const queueTimeout = setTimeout(()=> {
        shiftSendMessageQueue(queue.id, 'reject', {status: 'timeout'});
    }, queue.timeout);

    const sbdwtResult = await sendATCommand('AT+SBDWT\r', 'READY'); 
    const messageResult = await sendATCommand(queue.message + '\r');
    const sbdix = await sbdixExecute(queue.retries);

    if(sbdix.isSent) {
        await checkInbox(sbdix.parsedSBDIX);
    }

    clearTimeout(queueTimeout);
    shiftSendMessageQueue(queue.id, 'resolve', {status: 'sent'});
}

const sendATCommand = async (cmd, delimiter = 'OK', usePrependDelimeter = false) => {
    return new Promise((resolve, reject) => {
        const id = uuid.v4();
        const timestamp = new Date().getTime();

        atCommandQueue.push({
            id,
            cmd, 
            delimiter, 
            usePrependDelimeter, 
            timestamp            
        });

        console.log(`sendATCommand[${id}]: `, cmd);

        atCommandQueueEvent.on(id, ({status, data})=> {
            const response = {id, status, data};
            if(status === 'resolve') resolve(response);
            else reject(response);

            atCommandQueueEvent.removeListener(id, ()=> console.log(id, 'cleaned up event listener'));
        });

        if(atCommandQueue.length === 1) consumeATCommandQueue();
    });
}

parser.on('data', async (data) => {
    let isExpectedData = false;
    if (data.includes('SBDRING')) downloadMessage();
    else if (data.includes('ERROR')) shiftATCommandQueue(currentSerialJob.id, 'reject', data);
    else {
        if (currentSerialJob.usePrependDelimeter) {
            isExpectedData = currentSerialJob.previousDelimeter.includes(currentSerialJob.delimiter);
        } else {
            isExpectedData = data.includes(currentSerialJob.delimiter);
        }
        
        currentSerialJob.previousDelimeter = data;

        if(isExpectedData) {
            shiftATCommandQueue(currentSerialJob.id, 'resolve', data);
        }
    }
});

const downloadMessage = async () => {
    const sbdix = await sbdixExecute(15, true);
    await checkInbox(sbdix.parsedSBDIX);
}

const checkInbox = async (parsedSBDIX) => {
    let result = { message: '', isEmpty: true, sbdix : parsedSBDIX };

    const mailTimeout = setTimeout(() => {
        return result;
    }, 1 * 60000);

    if(parseInt(parsedSBDIX.MOStatus) < 4 && parseInt(parsedSBDIX.MTStatus) > 0) {
        const sbdrtResult = await sendATCommand('AT+SBDRT\r', '+SBDRT:', true);
        result.message = sbdrtResult.data;
        result.isEmpty = false;
        sbd.emit('message', result.message);

        if(parsedSBDIX.MTqueued > 0) {
            downloadMessage();
        }
    }

    clearTimeout(mailTimeout);

    return result;
}

const setCurrentSerialJob = (id = '', delimiter = 'OK', usePrependDelimeter = false, previousDelimeter = '')=>{
    currentSerialJob.id = id;
    currentSerialJob.delimiter = delimiter;
    currentSerialJob.usePrependDelimeter = usePrependDelimeter;
    currentSerialJob.previousDelimeter = previousDelimeter;
}

const sbdixExecute = async (retries = 10, isExtended = false) => {
    return new Promise((resolve, reject) => {
        const sendSBDIX = async () => {
            const sbdixResult = await sendATCommand(`AT+SBDIX${isExtended ? 'A' : ''}\r`, '+SBDIX:');
            const parsedSBDIX = parseSBDIX(sbdixResult.data);

            if(parsedSBDIX.MOStatus > 4) {
                currentSBDIXAttempts = currentSBDIXAttempts + 1;
                if(currentSBDIXAttempts < retries) setTimeout(sendSBDIX, 10000);
                else {
                    console.log('satellite timeout');
                    reject({parsedSBDIX, isSent: false});
                }
            } else resolve({parsedSBDIX, isSent: true});
        }

        sendSBDIX();
    });
}

const parseSBDIX = (str) => {
    let result = { MOStatus: '', MOMSN: '', MTStatus: '', MTMSN: '', MTLength: '', MTqueued: '', isValid: false };

    if (str.includes('+SBDIX:')) {
        const keyValue = str.split(' ');

        result = {
            MOStatus: parseInt(keyValue[1].replace(',', '')),
            MOMSN: parseInt(keyValue[2].replace(',', '')),
            MTStatus: parseInt(keyValue[3].replace(',', '')),
            MTMSN: parseInt(keyValue[4].replace(',', '')),
            MTLength: parseInt(keyValue[5].replace(',', '')),
            MTqueued: parseInt(keyValue[6].replace(',', '')),
            isValid: true
        };
    }

    return result;
};

const getSignalStrength = async () => {
    const result = await sendATCommand('AT+CSQ\r', '+CSQ:');
    let parsedResult = result.data.replace('+CSQ:', '').split("\r");
 
    return parseInt(parsedResult[0]);
}

const send = async (message, retries = 10, timeout = 120000) => {
    return new Promise((resolve, reject) => {
        const id = uuid.v4();
        const timestamp = new Date().getTime();

        sendMessageQueue.push({
            id,
            message,
            retries,
            timeout,
            timestamp            
        });

        sendMessageQueueEvent.on(id, ({status, data})=> {
            const response = {id, status, data};
            if(status === 'resolve') resolve(response);
            else reject(response);

            sendMessageQueueEvent.removeListener(id, ()=> console.log(id, 'cleaned up event listener'));
        });

        if(sendMessageQueue.length === 1) consumeSendMessageQueue();        
    });
}

module.exports = {
    getSignalStrength,
    send,
    sbd
}