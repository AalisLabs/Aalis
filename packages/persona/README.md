# Persona Inquiry JavaScript SDK

The official JavaScript client library for the Persona Inquiry flow.

## [Demo](https://ccq8nh.csb.app/)

## Table of Contents

- Persona Inquiry JavaScript SDK
  - [Documentation](#documentation)
  - [Getting Started](#getting-started)
  - [Contributing](#contributing)
  - [License](#license)

## Documentation

The module provides a client for the Persona embedded flow.

- [Integration documentation](https://docs.withpersona.com/docs/embedded-flow).
- [Changelog](https://docs.withpersona.com/docs/embedded-flow-changelog).

## Getting Started

```bash
npm install persona
```

To open the flow you must create a `Client` object.

```javascript
import { Client } from 'persona';

const client = new Client({
  // This refers to a production demo template owned by Persona
  templateId: 'itmpl_Ygs16MKTkA6obnF8C3Rb17dm',
  environment: 'sandbox',
  onReady: () => client.open(),
  onComplete: ({ inquiryId, status, fields }) => console.log('onComplete'),
  onCancel: ({ inquiryId, sessionToken }) => console.log('onCancel'),
  onError: (error) => console.log(error),
});
```

## Contributing

Please see [Contributing](../../CONTRIBUTING.md) for guidelines and instructions for local development.

## License

[MIT](LICENSE)
